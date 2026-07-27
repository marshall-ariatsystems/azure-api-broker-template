'use strict';

const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { PolicyStore, publicConnections, mutateGrant, vendorIdFor, updateConnectionStatus, recordRotation } = require('./policy-store');

const OPERATOR_ROLE = 'Ariat.Operator';
const MAX_BODY = 64 * 1024;
const credential = new DefaultAzureCredential();
const policyStore = process.env.APP_CONFIG_ENDPOINT ? new PolicyStore({ endpoint: process.env.APP_CONFIG_ENDPOINT, credential }) : null;
const secretClient = process.env.KEYVAULT_URI ? new SecretClient(process.env.KEYVAULT_URI, credential) : null;
const auditTable = process.env.AUDIT_STORAGE_ACCOUNT
  ? new TableClient(`https://${process.env.AUDIT_STORAGE_ACCOUNT}.table.core.windows.net`, process.env.AUDIT_TABLE_NAME || 'operatorAudit', credential)
  : null;

function response(status, jsonBody) { return { status, jsonBody, headers: { 'cache-control': 'no-store' } }; }
function principal(request) {
  const encoded = request.headers.get('x-ms-client-principal');
  if (!encoded) return { oid: null, roles: [] };
  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).claims || [];
    const roleValues = claims.filter((claim) => /(^|\/)role(s)?$/i.test(claim.typ || '') || /^roles?$/i.test(claim.typ || '')).map((claim) => claim.val);
    const oid = claims.find((claim) => /(^|\/)(oid|objectidentifier)$/i.test(claim.typ || ''))?.val || null;
    return { oid, roles: roleValues };
  } catch { return { oid: null, roles: [] }; }
}
function requireOperator(request) {
  const value = principal(request);
  if (!value.oid || !value.roles.includes(OPERATOR_ROLE)) { const error = new Error('forbidden'); error.status = 403; throw error; }
  return value;
}
async function body(request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) throw new TypeError('invalid request');
  try { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw new TypeError('invalid request'); }
}
async function audit(actor, action, connectionId, outcome, metadata = {}) {
  if (!auditTable) return;
  await auditTable.createTable().catch(() => undefined);
  await auditTable.createEntity({ partitionKey: connectionId, rowKey: crypto.randomUUID(), at: new Date().toISOString(), actor: actor.oid, action, outcome, ...metadata });
}
function configured() { if (!policyStore || !secretClient) { const error = new Error('management service misconfigured'); error.status = 503; throw error; } }
function safeGrants(doc, connectionId) {
  const entry = doc.connections.find((item) => item.id === connectionId);
  return entry ? { id: entry.id, subjects: entry.subjects || [], groups: entry.groups || [], workloads: entry.workloads || [] } : { id: connectionId, subjects: [], groups: [], workloads: [] };
}
function secretName(entry) { return typeof entry === 'string' ? entry : entry.secret; }
function findConnection(roleMap, connectionId) {
  return Object.entries(roleMap).find(([role, entry]) => publicConnections({ [role]: entry })[0].id === connectionId);
}
async function recordedRotation(entry) {
  if (entry && typeof entry === 'object' && entry.lastRotatedAt) return entry.lastRotatedAt;
  // List only Key Vault version metadata, never a secret value. This supplies a useful baseline
  // for keys that existed before the operator console started recording rotations.
  let latest = null;
  try {
    for await (const version of secretClient.listPropertiesOfSecretVersions(secretName(entry))) {
      const created = version.createdOn && version.createdOn.toISOString();
      if (created && (!latest || created > latest)) latest = created;
    }
  } catch { /* Metadata access is optional; absence is reported as unrecorded. */ }
  return latest;
}
async function connectionsWithRotation(roleMap) {
  const base = publicConnections(roleMap);
  return Promise.all(base.map(async (item) => {
    const found = findConnection(roleMap, item.id);
    return { ...item, lastRotatedAt: await recordedRotation(found[1]) };
  }));
}
function dashboardMetrics(connections, grants) {
  const active = connections.filter((item) => item.enabled);
  const users = new Set();
  for (const grant of grants.connections) for (const subject of grant.subjects || []) users.add(subject);
  const dated = active.filter((item) => item.lastRotatedAt);
  const longest = dated.length ? dated.reduce((oldest, item) => Date.parse(item.lastRotatedAt) < Date.parse(oldest.lastRotatedAt) ? item : oldest) : null;
  return {
    deployedKeys: active.length,
    disabledKeys: connections.length - active.length,
    usersWithKeys: users.size,
    longestWithoutRotation: longest ? { id: longest.id, lastRotatedAt: longest.lastRotatedAt } : null,
  };
}
function publicVendors(current) {
  const connections = publicConnections(current.roleMap);
  const profiles = new Map(current.vendors.vendors.map((vendor) => [vendor.id, vendor]));
  for (const connection of connections) if (!profiles.has(connection.vendorId)) profiles.set(connection.vendorId, { id: connection.vendorId, displayName: connection.vendor });
  return [...profiles.values()].map((vendor) => ({ ...vendor, keys: connections.filter((connection) => connection.vendorId === vendor.id).map((connection) => ({ id: connection.id, displayName: connection.displayName, status: connection.status })) })).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
function vendorInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['id', 'displayName', 'baseUrl', 'documentationUrl', 'authType'].includes(key))) throw new TypeError('invalid vendor');
  const id = typeof input.id === 'string' ? input.id.toLowerCase() : '';
  const vendor = { id, displayName: input.displayName, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.documentationUrl ? { documentationUrl: input.documentationUrl } : {}), ...(input.authType ? { authType: input.authType } : {}) };
  if (vendorIdFor(id) !== id || id === 'unassigned' || typeof vendor.displayName !== 'string' || !vendor.displayName) throw new TypeError('invalid vendor');
  if (vendor.baseUrl && !/^https:\/\//.test(vendor.baseUrl)) throw new TypeError('invalid vendor');
  if (vendor.documentationUrl && !/^https:\/\//.test(vendor.documentationUrl)) throw new TypeError('invalid vendor');
  if (vendor.authType && !['api-key', 'bearer', 'basic', 'oauth2cc', 'entra'].includes(vendor.authType)) throw new TypeError('invalid vendor');
  return vendor;
}
function connectionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['role', 'secret', 'displayName', 'vendor', 'baseUrl', 'inject'].includes(key))) throw new TypeError('invalid connection');
  const value = { role: input.role, secret: input.secret, displayName: input.displayName, vendor: input.vendor, baseUrl: input.baseUrl, inject: input.inject };
  if (typeof value.role !== 'string' || !/^VendorApi\.[A-Za-z0-9][A-Za-z0-9.-]{0,127}\.Invoke$/.test(value.role) || typeof value.secret !== 'string' || !/^[0-9A-Za-z-]{1,127}$/.test(value.secret) || typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 256 || typeof value.vendor !== 'string' || vendorIdFor(value.vendor) === 'unassigned' || typeof value.baseUrl !== 'string' || !/^https:\/\//.test(value.baseUrl) || !['header', 'bearer', 'pair', 'basic', 'oauth2cc', 'entra'].includes(value.inject)) throw new TypeError('invalid connection');
  return { ...value, displayName: value.displayName.trim(), vendor: value.vendor.trim(), baseUrl: value.baseUrl.replace(/\/+$/, '') };
}
function principalInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['id', 'displayName'].includes(key)) || typeof input.id !== 'string' || !/^(user|group|workload):[^\s]{1,240}$/.test(input.id) || typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 256) throw new TypeError('invalid principal');
  return { id: input.id, displayName: input.displayName.trim() };
}
function publicPrincipals(current) {
  const known = new Map(current.principals.principals.map((principal) => [principal.id, principal]));
  for (const grant of current.grants.connections) for (const field of ['subjects', 'groups', 'workloads']) for (const id of grant[field] || []) if (!known.has(id)) known.set(id, { id, displayName: id });
  return [...known.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}
async function recentAuditEvents(limit = 500) {
  if (!auditTable) return [];
  const events = [];
  try {
    for await (const row of auditTable.listEntities()) {
      events.push({ at: row.at, actor: row.actor || row.callerOid, action: row.action, connectionId: row.connectionId || row.partitionKey, outcome: row.outcome, method: row.method, route: row.route, durationMs: row.durationMs, requestContent: row.requestContent, responseContent: row.responseContent, requestTruncated: row.requestTruncated, responseTruncated: row.responseTruncated, apiPath: row.apiPath, pagePath: row.pagePath, clientStatus: row.clientStatus, clientDurationMs: row.clientDurationMs });
      if (events.length >= limit) break;
    }
  } catch { return []; }
  return events.filter((event) => typeof event.at === 'string').sort((a, b) => b.at.localeCompare(a.at));
}
function clientCall(input) {
  const apiPath = typeof input.apiPath === 'string' ? input.apiPath : '';
  const pagePath = typeof input.pagePath === 'string' ? input.pagePath : '';
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : '';
  const status = Number(input.status);
  const durationMs = Number(input.durationMs);
  const knownApi = /^\/api\/(?:dashboard|logs|monitoring|vendors|principals|connections(?:\/[^/?#]+(?:\/(?:grants|credential|status))?)?)$/.test(apiPath);
  if (!knownApi || !/^\/console(?:\/keys\/[^/?#]+)?$/.test(pagePath) || !['GET', 'POST', 'DELETE'].includes(method) || !Number.isInteger(status) || status < 0 || status > 599 || !Number.isInteger(durationMs) || durationMs < 0 || durationMs > 60000) throw new TypeError('client call is invalid');
  return { apiPath, pagePath, method, status, durationMs };
}
function monitoring(events) {
  const alerts = [];
  for (const event of events) {
    if (event.action === 'client.api.call') {
      if (!event.apiPath || !event.pagePath) alerts.push({ severity: 'high', type: 'malformed-client-record', at: event.at, detail: 'Client call record is missing an expected location.' });
      else if (Number(event.clientStatus) === 0 || Number(event.clientStatus) >= 400) alerts.push({ severity: Number(event.clientStatus) >= 500 || Number(event.clientStatus) === 0 ? 'high' : 'medium', type: 'client-api-failure', at: event.at, detail: `${event.method} ${event.apiPath} returned ${event.clientStatus}.` });
      else if (Number(event.clientDurationMs) > 10000) alerts.push({ severity: 'medium', type: 'slow-client-call', at: event.at, detail: `${event.method} ${event.apiPath} took ${event.clientDurationMs}ms.` });
    }
    if (event.action === 'broker.api.call') {
      if (Number(event.outcome) >= 500) alerts.push({ severity: 'high', type: 'broker-delivery-failure', at: event.at, detail: `${event.method} /${event.route} returned ${event.outcome}.` });
      else if (Number(event.durationMs) > 10000) alerts.push({ severity: 'medium', type: 'slow-broker-call', at: event.at, detail: `${event.method} /${event.route} took ${event.durationMs}ms.` });
    }
  }
  return { alerts: alerts.slice(0, 100), summary: { scanned: events.length, high: alerts.filter((item) => item.severity === 'high').length, medium: alerts.filter((item) => item.severity === 'medium').length } };
}

async function api(request, context) {
  let actor;
  try {
    actor = requireOperator(request); configured();
    const path = request.params.path || '';
    if (request.method === 'GET' && path === 'dashboard') {
      const current = await policyStore.read();
      const connections = await connectionsWithRotation(current.roleMap);
      return response(200, { connections, metrics: dashboardMetrics(connections, current.grants) });
    }
    if (request.method === 'GET' && path === 'vendors') { const current = await policyStore.read(); return response(200, { vendors: publicVendors(current) }); }
    if (request.method === 'POST' && path === 'vendors') {
      const current = await policyStore.read(); const input = vendorInput(await body(request));
      const next = { version: 1, vendors: [...current.vendors.vendors.filter((vendor) => vendor.id !== input.id), input].sort((a, b) => a.displayName.localeCompare(b.displayName)) };
      await policyStore.writeVendors(next, current.etags.vendors); await audit(actor, 'vendor.upserted', `vendor:${input.id}`, 'allowed');
      return response(200, { vendor: publicVendors({ ...current, vendors: next }).find((vendor) => vendor.id === input.id) });
    }
    if (request.method === 'GET' && path === 'principals') { const current = await policyStore.read(); return response(200, { principals: publicPrincipals(current) }); }
    if (request.method === 'POST' && path === 'principals') {
      const current = await policyStore.read(); const input = principalInput(await body(request));
      const next = { version: 1, principals: [...current.principals.principals.filter((principal) => principal.id !== input.id), input].sort((a, b) => a.displayName.localeCompare(b.displayName)) };
      await policyStore.writePrincipals(next, current.etags.principals); await audit(actor, 'principal.upserted', `principal:${input.id}`, 'allowed');
      return response(200, { principal: input });
    }
    if (request.method === 'GET' && path === 'logs') return response(200, { events: await recentAuditEvents() });
    if (request.method === 'GET' && path === 'monitoring') return response(200, monitoring(await recentAuditEvents()));
    if (request.method === 'POST' && path === 'client-events') {
      const event = clientCall(await body(request));
      await audit(actor, 'client.api.call', 'client-call', 'recorded', { apiPath: event.apiPath, pagePath: event.pagePath, method: event.method, clientStatus: String(event.status), clientDurationMs: String(event.durationMs) });
      return response(202, { recorded: true });
    }
    if (request.method === 'GET' && path === 'connections') {
      const current = await policyStore.read();
      return response(200, { connections: await connectionsWithRotation(current.roleMap) });
    }
    if (request.method === 'POST' && path === 'connections') {
      const current = await policyStore.read(); const input = connectionInput(await body(request));
      if (current.roleMap[input.role]) throw new TypeError('connection already exists');
      if (Object.values(current.roleMap).some((entry) => secretName(entry) === input.secret)) throw new TypeError('connection secret is already mapped');
      const next = { ...current.roleMap, [input.role]: { secret: input.secret, displayName: input.displayName, vendor: input.vendor, baseUrl: input.baseUrl, inject: input.inject, enabled: true } };
      await policyStore.writeRoleMap(next, current.etags.roleMap); await audit(actor, 'connection.created', `role:${input.role}`, 'allowed');
      return response(201, { connection: publicConnections(next).find((connection) => connection.role === input.role) });
    }
    const connectionMatch = /^connections\/([^/]+)$/.exec(path);
    if (connectionMatch && request.method === 'GET') {
      const connectionId = decodeURIComponent(connectionMatch[1]);
      const current = await policyStore.read();
      const found = findConnection(current.roleMap, connectionId);
      if (!found) { const error = new Error('not found'); error.status = 404; throw error; }
      const connection = (await connectionsWithRotation({ [found[0]]: found[1] }))[0];
      return response(200, { connection, grant: safeGrants(current.grants, connectionId) });
    }
    const statusMatch = /^connections\/([^/]+)\/status$/.exec(path);
    if (statusMatch && request.method === 'POST') {
      const connectionId = decodeURIComponent(statusMatch[1]);
      const current = await policyStore.read();
      const input = await body(request);
      if (Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') throw new TypeError('invalid request');
      const next = updateConnectionStatus(current.roleMap, connectionId, input.enabled);
      await policyStore.writeRoleMap(next, current.etags.roleMap);
      await audit(actor, input.enabled ? 'connection.enabled' : 'connection.revoked', connectionId, 'allowed');
      return response(200, { connection: (await connectionsWithRotation({ [findConnection(next, connectionId)[0]]: findConnection(next, connectionId)[1] }))[0] });
    }
    const grantMatch = /^connections\/([^/]+)\/grants$/.exec(path);
    if (grantMatch && request.method === 'GET') {
      const current = await policyStore.read();
      return response(200, { grant: safeGrants(current.grants, decodeURIComponent(grantMatch[1])) });
    }
    const credentialMatch = /^connections\/([^/]+)\/credential$/.exec(path);
    if (credentialMatch && request.method === 'POST') {
      const connectionId = decodeURIComponent(credentialMatch[1]);
      const current = await policyStore.read();
      const found = findConnection(current.roleMap, connectionId);
      const input = await body(request);
      if (!found || Object.keys(input).length !== 1 || typeof input.credential !== 'string' || !input.credential || input.credential.length > 32 * 1024) throw new TypeError('invalid request');
      const entry = found[1]; const keyName = secretName(entry);
      const stored = await secretClient.setSecret(keyName, input.credential);
      const rotatedAt = stored.properties.createdOn ? stored.properties.createdOn.toISOString() : new Date().toISOString();
      const nextRoleMap = recordRotation(current.roleMap, connectionId, rotatedAt);
      await policyStore.writeRoleMap(nextRoleMap, current.etags.roleMap);
      await audit(actor, 'connection.credential.rotated', connectionId, 'allowed');
      return response(200, { connection: (await connectionsWithRotation({ [found[0]]: nextRoleMap[found[0]] }))[0], credential: { stored: true } });
    }
    if (grantMatch && (request.method === 'POST' || request.method === 'DELETE')) {
      const connectionId = decodeURIComponent(grantMatch[1]);
      const current = await policyStore.read();
      if (!publicConnections(current.roleMap).some((item) => item.id === connectionId)) { const error = new Error('not found'); error.status = 404; throw error; }
      const input = await body(request);
      if (Object.keys(input).length !== 2 || typeof input.kind !== 'string' || typeof input.subject !== 'string') throw new TypeError('invalid request');
      const next = mutateGrant(current.grants, connectionId, input.kind, input.subject, request.method === 'DELETE');
      await policyStore.writeGrants(next, current.etags.grants);
      await audit(actor, request.method === 'DELETE' ? 'grant.deleted' : 'grant.created', connectionId, 'allowed');
      return response(200, { grant: safeGrants(next, connectionId) });
    }
    return response(404, { error: 'not found' });
  } catch (error) {
    context.error(`[operator] ${error.message}`);
    const status = error.status === 403 ? 403 : error.status === 404 ? 404 : error.status === 503 ? 503 : 400;
    return response(status, { error: status === 403 ? 'forbidden' : status === 404 ? 'not found' : status === 503 ? 'unavailable' : 'invalid request' });
  }
}

app.http('operatorApi', { methods: ['GET', 'POST', 'DELETE'], authLevel: 'anonymous', route: 'api/{*path}', handler: api });
app.http('operatorConsole', {
  methods: ['GET'], authLevel: 'anonymous', route: 'console',
  handler: async () => {
    const [html, guided, monitor] = await Promise.all([readFile(path.resolve(__dirname, '../public/index.html'), 'utf8'), readFile(path.resolve(__dirname, '../public/guided-ui.js'), 'utf8'), readFile(path.resolve(__dirname, '../public/client-monitor.js'), 'utf8')]);
    return { status: 200, body: html.replace('<script>', `<script>${monitor}</script><script>`).replace('</body>', `<script>${guided}</script></body>`), headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } };
  },
});
app.http('operatorKeyConsole', {
  methods: ['GET'], authLevel: 'anonymous', route: 'console/keys/{*path}',
  handler: async () => {
    const [html, guided, monitor] = await Promise.all([readFile(path.resolve(__dirname, '../public/index.html'), 'utf8'), readFile(path.resolve(__dirname, '../public/guided-ui.js'), 'utf8'), readFile(path.resolve(__dirname, '../public/client-monitor.js'), 'utf8')]);
    return { status: 200, body: html.replace('<script>', `<script>${monitor}</script><script>`).replace('</body>', `<script>${guided}</script></body>`), headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } };
  },
});
