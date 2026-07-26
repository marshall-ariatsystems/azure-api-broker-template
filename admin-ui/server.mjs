import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 64 * 1024;
const GRANT_KINDS = new Set(['user', 'group', 'workload']);
const HANDOFF_KINDS = new Set(['marketplace', 'private', 'generic']);
const SUBJECT_LOCAL = /^[a-z0-9][a-z0-9._@/-]{0,127}$/;
const FORBIDDEN = /^(?:scope|operation|secret|credential|baseUrl|authorization|token|vendor|client_secret)$/i;

const own = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
const publicIdentity = (value) => own(value, ['id', 'kind', 'handoffKind', 'displayName', 'issuer', 'status']);
const publicConnection = (value) => own(value, ['id', 'provider', 'displayName', 'status', 'createdAt']);
const publicGrant = (value) => own(value, ['id', 'connectionId', 'subject', 'kind']);
const publicUsage = (value) => own(value, ['connectionId', 'window', 'requests', 'denied', 'status', 'observedAt']);
const publicAudit = (value) => own(value, ['at', 'action', 'connectionId', 'outcome']);
const response = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const invalid = () => { const error = new Error('invalid request'); error.status = 400; return error; };
const notFound = () => { const error = new Error('not found'); error.status = 404; return error; };

export function normalizeGrant(kind, subject) {
  if (typeof kind !== 'string' || typeof subject !== 'string') throw invalid();
  const normalizedKind = kind.toLowerCase();
  const expectedPrefix = `${normalizedKind}:`;
  if (!GRANT_KINDS.has(normalizedKind) || !subject.startsWith(expectedPrefix)) throw invalid();
  const local = subject.slice(expectedPrefix.length);
  if (subject !== subject.trim() || subject !== subject.normalize('NFC') || local !== local.toLowerCase() || !SUBJECT_LOCAL.test(local)) throw invalid();
  return Object.freeze({ kind: normalizedKind, subject: `${normalizedKind}:${local}` });
}

function assertKeys(body, allowed) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw invalid();
  for (const key of Object.keys(body)) if (!allowed.has(key) || FORBIDDEN.test(key) && !allowed.has(key)) throw invalid();
}

function publicText(value) {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 128;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw invalid();
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
}

function requireConnection(repository, id) {
  return Promise.resolve(repository.getConnection(id)).then((connection) => {
    if (!connection) throw notFound();
    return connection;
  });
}

export function createAdminConsole({ requireAdmin, repository, credentialWriter, brokerProbe, auditSink, logger = { info() {} } }) {
  if (!requireAdmin || !repository || !credentialWriter || !auditSink) throw new TypeError('missing trusted server adapter');
  const authenticated = async (request) => {
    const admin = await requireAdmin(request);
    if (!admin || !Array.isArray(admin.permissions) || !admin.permissions.includes('admin:connections')) {
      const error = new Error('forbidden'); error.status = 403; throw error;
    }
    return admin;
  };
  const auditMutation = async (action, connectionId, outcome) => auditSink.write({ action, connectionId, outcome });

  return async function api(request, res) {
    const url = new URL(request.url, 'http://same-origin.invalid');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      await authenticated(request);
      if (url.search !== '' || request.url.includes('?')) throw invalid();
      const { pathname } = url;
      const method = request.method;
      if (method === 'GET' && pathname === '/api/identity-integrations') {
        return response(res, 200, { identityIntegrations: (await repository.listIdentityIntegrations()).map(publicIdentity) });
      }
      if (method === 'POST' && pathname === '/api/identity-integrations') {
        const body = await readBody(request); assertKeys(body, new Set(['kind', 'displayName', 'issuer', 'handoffKind']));
        if (!publicText(body.kind) || !publicText(body.displayName) || typeof body.issuer !== 'string' || !/^https:\/\/.+/.test(body.issuer) || !HANDOFF_KINDS.has(body.handoffKind)) throw invalid();
        const created = await repository.createIdentityIntegration({ kind: body.kind, displayName: body.displayName, issuer: body.issuer, handoffKind: body.handoffKind, status: 'connected' });
        return response(res, 201, { identityIntegration: publicIdentity(created) });
      }
      if (method === 'GET' && pathname === '/api/connections') {
        return response(res, 200, { connections: (await repository.listConnections()).map(publicConnection) });
      }
      if (method === 'POST' && pathname === '/api/connections') {
        const body = await readBody(request); assertKeys(body, new Set(['displayName', 'provider', 'credential']));
        if (!publicText(body.displayName) || !publicText(body.provider) || (Object.hasOwn(body, 'credential') && typeof body.credential !== 'string')) throw invalid();
        const id = `connection:${crypto.randomUUID()}`;
        if (Object.hasOwn(body, 'credential')) {
          const stored = await credentialWriter.write({ connectionId: id, credential: body.credential });
          if (!stored || stored.stored !== true) throw invalid();
        }
        const created = await repository.createConnection({ id, displayName: body.displayName, provider: body.provider, status: 'healthy', createdAt: new Date().toISOString() });
        await auditMutation('connection.created', created.id, 'allowed');
        return response(res, 201, { connection: publicConnection(created) });
      }
      const credentialMatch = pathname.match(/^\/api\/connections\/([^/]+)\/credential$/);
      if (method === 'POST' && credentialMatch) {
        const connection = await requireConnection(repository, decodeURIComponent(credentialMatch[1]));
        const body = await readBody(request); assertKeys(body, new Set(['credential']));
        if (typeof body.credential !== 'string') throw invalid();
        const stored = await credentialWriter.write({ connectionId: connection.id, credential: body.credential });
        if (!stored || stored.stored !== true) throw invalid();
        await auditMutation('connection.credential.updated', connection.id, 'allowed');
        return response(res, 200, { connection: publicConnection(connection) });
      }
      const grantsMatch = pathname.match(/^\/api\/connections\/([^/]+)\/grants(?:\/([^/]+))?$/);
      if (grantsMatch) {
        const connection = await requireConnection(repository, decodeURIComponent(grantsMatch[1]));
        if (method === 'GET' && !grantsMatch[2]) return response(res, 200, { grants: (await repository.listGrants(connection.id)).map(publicGrant) });
        if (method === 'POST' && !grantsMatch[2]) {
          const body = await readBody(request); assertKeys(body, new Set(['kind', 'subject']));
          const grant = normalizeGrant(body.kind, body.subject);
          if ((await repository.listGrants(connection.id)).some((item) => item.subject === grant.subject)) throw invalid();
          const created = await repository.createGrant({ id: `grant:${crypto.randomUUID()}`, connectionId: connection.id, ...grant });
          await auditMutation('grant.created', connection.id, 'allowed');
          return response(res, 201, { grant: publicGrant(created) });
        }
        if (method === 'DELETE' && grantsMatch[2]) {
          const deleted = await repository.deleteGrant(connection.id, decodeURIComponent(grantsMatch[2]));
          if (!deleted) throw notFound();
          await auditMutation('grant.deleted', connection.id, 'allowed');
          return response(res, 200, { grant: publicGrant(deleted) });
        }
      }
      const observedMatch = pathname.match(/^\/api\/connections\/([^/]+)\/(health|usage|audit)$/);
      if (method === 'GET' && observedMatch) {
        const connection = await requireConnection(repository, decodeURIComponent(observedMatch[1]));
        if (observedMatch[2] === 'health') {
          const usage = await repository.getUsage(connection.id);
          return response(res, 200, { health: own({ connectionId: connection.id, status: usage?.status || connection.status }, ['connectionId', 'status']) });
        }
        if (observedMatch[2] === 'usage') return response(res, 200, { usage: publicUsage(await repository.getUsage(connection.id)) });
        return response(res, 200, { audit: (await repository.listAudit(connection.id)).map(publicAudit) });
      }
      throw notFound();
    } catch (error) {
      const code = error?.status === 403 ? 403 : error?.status === 404 ? 404 : error?.status === 400 ? 400 : 401;
      return response(res, code, { error: code === 404 ? 'not found' : code === 401 ? 'unauthorized' : code === 403 ? 'forbidden' : 'invalid request' });
    }
  };
}

export function createHttpHandler(options) {
  const api = createAdminConsole(options);
  const indexPath = new URL('./index.html', import.meta.url);
  return async (request, responseWriter) => {
    if (await api(request, responseWriter) !== false) return;
    const url = new URL(request.url, 'http://same-origin.invalid');
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && url.search === '') {
      responseWriter.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      responseWriter.end(await readFile(fileURLToPath(indexPath)));
      return;
    }
    response(responseWriter, 404, { error: 'not found' });
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const unavailable = () => { throw new Error('A hosted adapter must supply trusted administrator and repository services.'); };
  http.createServer(createHttpHandler({ requireAdmin: unavailable, repository: {}, credentialWriter: {}, auditSink: {} })).listen(8788);
}
