'use strict';

const { AppConfigurationClient } = require('@azure/app-configuration');
const { DefaultAzureCredential } = require('@azure/identity');

const ROLE_MAP_KEY = 'tessera:broker:role-map';
const GRANTS_KEY = 'tessera:broker:connection-grants';
const VENDORS_KEY = 'tessera:broker:vendor-profiles';
const PRINCIPALS_KEY = 'tessera:broker:principal-profiles';
const CONTENT_TYPE = 'application/json';
const MAX_BYTES = 64 * 1024;
const OWN = Object.prototype.hasOwnProperty;

function fail(message) { throw new TypeError(message); }
function json(value, name) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail(`${name} is invalid`);
  try { return JSON.parse(value); } catch { fail(`${name} is invalid`); }
}
function roleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) fail('role map is invalid');
  for (const [role, entry] of Object.entries(value)) {
    if (typeof role !== 'string' || !role || role.length > 256) fail('role map is invalid');
    if (typeof entry === 'string' && entry) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.secret !== 'string' || !entry.secret) fail('role map is invalid');
    if (OWN.call(entry, 'enabled') && typeof entry.enabled !== 'boolean') fail('role map is invalid');
    if (OWN.call(entry, 'displayName') && (typeof entry.displayName !== 'string' || !entry.displayName || entry.displayName.length > 256)) fail('role map is invalid');
    if (OWN.call(entry, 'vendor') && (typeof entry.vendor !== 'string' || !entry.vendor || entry.vendor.length > 256)) fail('role map is invalid');
    if (OWN.call(entry, 'lastRotatedAt') && (typeof entry.lastRotatedAt !== 'string' || Number.isNaN(Date.parse(entry.lastRotatedAt)))) fail('role map is invalid');
  }
  return value;
}
function grants(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.connections)) fail('connection grants are invalid');
  return value;
}
function vendors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.vendors) || value.vendors.length > 128) fail('vendor profiles are invalid');
  const ids = new Set();
  for (const vendor of value.vendors) {
    if (!vendor || typeof vendor !== 'object' || Array.isArray(vendor) || typeof vendor.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(vendor.id) || ids.has(vendor.id) || typeof vendor.displayName !== 'string' || !vendor.displayName || vendor.displayName.length > 128) fail('vendor profiles are invalid');
    ids.add(vendor.id);
    for (const field of ['baseUrl', 'documentationUrl']) if (vendor[field] !== undefined && (typeof vendor[field] !== 'string' || vendor[field].length > 512 || !/^https:\/\//.test(vendor[field]))) fail('vendor profiles are invalid');
    if (vendor.authType !== undefined && !['api-key', 'bearer', 'basic', 'oauth2cc', 'entra'].includes(vendor.authType)) fail('vendor profiles are invalid');
  }
  return value;
}
function principals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.principals) || value.principals.length > 1024) fail('principal profiles are invalid');
  const ids = new Set();
  for (const principal of value.principals) {
    if (!principal || typeof principal !== 'object' || Array.isArray(principal) || typeof principal.id !== 'string' || !/^(user|group|workload):[^\s]{1,240}$/.test(principal.id) || ids.has(principal.id) || typeof principal.displayName !== 'string' || !principal.displayName || principal.displayName.length > 256) fail('principal profiles are invalid');
    ids.add(principal.id);
  }
  return value;
}

class PolicyStore {
  constructor({ endpoint, credential = new DefaultAzureCredential(), client } = {}) {
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) throw new TypeError('App Configuration endpoint is required');
    this.client = client || new AppConfigurationClient(endpoint, credential);
  }

  async read() {
    const [roleMapSetting, grantSetting, vendorSetting, principalSetting] = await Promise.all([
      this.client.getConfigurationSetting({ key: ROLE_MAP_KEY }),
      this.client.getConfigurationSetting({ key: GRANTS_KEY }),
      this.client.getConfigurationSetting({ key: VENDORS_KEY }).catch((error) => error.statusCode === 404 ? null : Promise.reject(error)),
      this.client.getConfigurationSetting({ key: PRINCIPALS_KEY }).catch((error) => error.statusCode === 404 ? null : Promise.reject(error)),
    ]);
    return Object.freeze({
      roleMap: roleMap(json(roleMapSetting.value, 'role map')),
      grants: grants(json(grantSetting.value, 'connection grants')),
      vendors: vendorSetting ? vendors(json(vendorSetting.value, 'vendor profiles')) : Object.freeze({ version: 1, vendors: [] }),
      principals: principalSetting ? principals(json(principalSetting.value, 'principal profiles')) : Object.freeze({ version: 1, principals: [] }),
      etags: Object.freeze({ roleMap: roleMapSetting.etag, grants: grantSetting.etag, vendors: vendorSetting?.etag, principals: principalSetting?.etag }),
    });
  }

  async writeGrants(document, etag) {
    grants(document);
    const value = JSON.stringify(document);
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail('connection grants are invalid');
    return this.client.setConfigurationSetting({
      key: GRANTS_KEY,
      value,
      contentType: CONTENT_TYPE,
      ...(etag ? { onlyIfUnchanged: true, etag } : {}),
    });
  }

  async writeRoleMap(document, etag) {
    roleMap(document);
    const value = JSON.stringify(document);
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail('role map is invalid');
    return this.client.setConfigurationSetting({
      key: ROLE_MAP_KEY,
      value,
      contentType: CONTENT_TYPE,
      ...(etag ? { onlyIfUnchanged: true, etag } : {}),
    });
  }

  async writeVendors(document, etag) {
    vendors(document);
    const value = JSON.stringify(document);
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail('vendor profiles are invalid');
    return this.client.setConfigurationSetting({ key: VENDORS_KEY, value, contentType: CONTENT_TYPE, ...(etag ? { onlyIfUnchanged: true, etag } : {}) });
  }
  async writePrincipals(document, etag) {
    principals(document);
    const value = JSON.stringify(document);
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail('principal profiles are invalid');
    return this.client.setConfigurationSetting({ key: PRINCIPALS_KEY, value, contentType: CONTENT_TYPE, ...(etag ? { onlyIfUnchanged: true, etag } : {}) });
  }
}

function connectionIdForRole(role, entry) {
  if (entry && typeof entry === 'object' && typeof entry.connectionId === 'string' && entry.connectionId) return entry.connectionId;
  const part = String(role).split('.').find((value) => value && !/^(vendorapi|invoke)$/i.test(value));
  return `azure:${String(part || role).toLowerCase()}`;
}
function vendorIdFor(value) { return String(value || 'unassigned').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'unassigned'; }

function publicConnections(map) {
  return Object.entries(map).map(([role, entry]) => ({
    id: connectionIdForRole(role, entry),
    role,
    // Key Vault secret names are the authoritative operator-facing labels. Entra role values
    // remain available for diagnostics, but are never used as the default display name.
    displayName: (entry && typeof entry === 'object' && typeof entry.displayName === 'string') ? entry.displayName : (typeof entry === 'string' ? entry : entry.secret),
    vendor: (entry && typeof entry === 'object' && typeof entry.vendor === 'string') ? entry.vendor : (typeof entry === 'string' ? entry : entry.secret),
    vendorId: vendorIdFor((entry && typeof entry === 'object' && typeof entry.vendor === 'string') ? entry.vendor : (typeof entry === 'string' ? entry : entry.secret)),
    provider: 'Azure Key Vault',
    status: entry && typeof entry === 'object' && entry.enabled === false ? 'disabled' : 'active',
    enabled: !(entry && typeof entry === 'object' && entry.enabled === false),
    lastRotatedAt: entry && typeof entry === 'object' && typeof entry.lastRotatedAt === 'string' ? entry.lastRotatedAt : null,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function updateConnectionStatus(map, connectionId, enabled) {
  if (typeof enabled !== 'boolean') fail('connection status is invalid');
  const copy = JSON.parse(JSON.stringify(map));
  const found = Object.entries(copy).find(([role, entry]) => connectionIdForRole(role, entry) === connectionId);
  if (!found) fail('connection is not found');
  const [role, entry] = found;
  copy[role] = typeof entry === 'string' ? { secret: entry, enabled } : { ...entry, enabled };
  return copy;
}

function recordRotation(map, connectionId, rotatedAt) {
  if (typeof rotatedAt !== 'string' || Number.isNaN(Date.parse(rotatedAt))) fail('rotation metadata is invalid');
  const copy = JSON.parse(JSON.stringify(map));
  const found = Object.entries(copy).find(([role, entry]) => connectionIdForRole(role, entry) === connectionId);
  if (!found) fail('connection is not found');
  const [role, entry] = found;
  copy[role] = typeof entry === 'string' ? { secret: entry, lastRotatedAt: rotatedAt } : { ...entry, lastRotatedAt: rotatedAt };
  return copy;
}

function mutateGrant(document, connectionId, kind, subject, remove = false) {
  if (!['user', 'group', 'workload'].includes(kind) || typeof subject !== 'string' || !subject.startsWith(`${kind}:`) || subject.length > 256) fail('grant is invalid');
  const field = kind === 'user' ? 'subjects' : kind === 'group' ? 'groups' : 'workloads';
  const copy = JSON.parse(JSON.stringify(document));
  let connection = copy.connections.find((item) => item.id === connectionId);
  if (!connection && !remove) { connection = { id: connectionId, [field]: [] }; copy.connections.push(connection); }
  if (!connection) return copy;
  const values = Array.isArray(connection[field]) ? connection[field] : [];
  const next = remove ? values.filter((item) => item !== subject) : [...new Set([...values, subject])];
  if (next.length) connection[field] = next;
  else delete connection[field];
  if (!connection.subjects && !connection.groups && !connection.workloads) copy.connections = copy.connections.filter((item) => item !== connection);
  return copy;
}

module.exports = { PolicyStore, ROLE_MAP_KEY, GRANTS_KEY, VENDORS_KEY, PRINCIPALS_KEY, publicConnections, mutateGrant, connectionIdForRole, vendorIdFor, updateConnectionStatus, recordRotation };
