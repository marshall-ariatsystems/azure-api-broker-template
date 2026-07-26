const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const authority = require('../src/hosted-authority');
const { createAzureReferenceAdapter } = require('../src/azure-reference-adapter');
const BROKER = path.join(__dirname, '..', 'src', 'broker.js');

test('public connections are credential-free and reject credential, scope, and operation fields', () => {
  const connection = authority.createConnection({ id: 'azure:test', provider: 'azure-reference', baseUrl: 'https://vendor.test', injection: 'header' });
  assert.deepEqual(JSON.parse(JSON.stringify(connection)), connection);
  for (const key of ['secret', 'apiKey', 'accessToken', 'password', 'credential', 'operations', 'scope', 'scopes']) {
    assert.throws(() => authority.createConnection({ ...connection, [key]: 'nope' }));
  }
});

test('Azure role-backed adapter permits only the selected role', () => {
  const adapter = createAzureReferenceAdapter(Object.freeze({ 'VendorApi.Test.Invoke': 'internal-secret' }));
  const connection = adapter.connectionForRole('VendorApi.Test.Invoke', { baseUrl: 'https://vendor.test/', inject: 'header' });
  assert.equal(connection.id, 'azure:test');
  assert.equal(connection.provider, 'azure-reference');
  assert.equal(Object.keys(connection).includes('secret'), false);
  const identity = authority.normalizeIdentity({ oid: 'caller', azp: 'client', roles: ['VendorApi.Test.Invoke'] });
  assert.deepEqual(authority.authorizeConnection({ identity, connection, policy: adapter.policy }), { allowed: true, reason: 'allowed' });
  assert.deepEqual(authority.authorizeConnection({ identity: authority.normalizeIdentity({ oid: 'caller', roles: ['Other'] }), connection, policy: adapter.policy }), { allowed: false, reason: 'denied' });
  assert.throws(() => authority.normalizeIdentity({ roles: ['VendorApi.Test.Invoke'] }));
});

function loadBroker({ deny = false, inject = 'header' } = {}) {
  process.env.KEYVAULT_URI = 'https://kv.vault.azure.net/';
  process.env.ROLE_SECRET_MAP = JSON.stringify({
    'VendorApi.Test.Invoke': inject === 'entra'
      ? { baseUrl: 'https://vendor.test', inject: 'entra', scope: 'https://vendor.test/.default' }
      : { secret: 'test-key', baseUrl: 'https://vendor.test', inject },
  });
  process.env.QUOTA_CALLER_PER_MIN = '1000';
  process.env.QUOTA_KEY_PER_MIN = '1000';
  process.env.RATE_LIMIT_FAIL_MODE = 'open';
  process.env.RATE_LIMIT_STORAGE_ACCOUNT = 'teststorage';
  process.env.CONNECTION_GRANTS_JSON = JSON.stringify({ version: 1, connections: [{ id: 'azure:test', subjects: ['user:DISTINCTIVE-OID'] }] });
  delete require.cache[require.resolve(BROKER)];
  delete require.cache[require.resolve('../src/azure-reference-adapter')];
  const handlers = {};
  const calls = { quota: 0, kv: 0, fetch: 0, logs: [], errors: [], outbound: null, scopes: [] };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === '@azure/functions') return { app: { http: (name, options) => { handlers[name] = options.handler; } } };
    if (request === '@azure/identity') return { DefaultAzureCredential: class { async getToken(scope) { calls.scopes.push(scope); return { token: 'managed-token' }; } } };
    if (request === '@azure/keyvault-secrets') return { SecretClient: class { async getSecret() { calls.kv++; return { value: 'DISTINCTIVE-SECRET-VALUE' }; } } };
    if (request === '@azure/data-tables') return { TableClient: class { async createTable() {} async createEntity() {} async getEntity() { calls.quota++; throw { statusCode: 404, code: 'ResourceNotFound' }; } async updateEntity() {} } };
    if (request === './hosted-authority' && deny) return { ...authority, authorizeConnection: () => ({ allowed: false, reason: 'denied' }) };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { require(BROKER); } finally { Module._load = originalLoad; }
  return { handler: handlers.broker, calls };
}

function request() {
  const principal = Buffer.from(JSON.stringify({ claims: [
    { typ: 'roles', val: 'VendorApi.Test.Invoke' }, { typ: 'oid', val: 'DISTINCTIVE-OID' }, { typ: 'azp', val: 'DISTINCTIVE-AZP' },
  ] })).toString('base64');
  return { method: 'GET', params: { path: 'resource' }, query: new URLSearchParams(), headers: new Map([['x-ms-client-principal', principal]]), arrayBuffer: async () => new ArrayBuffer(0) };
}

test('broker authority denial occurs before quota, Key Vault, and vendor calls', async () => {
  const { handler, calls } = loadBroker({ deny: true });
  global.fetch = async () => { calls.fetch++; throw new Error('must not fetch'); };
  const response = await handler(request(), { log: (line) => calls.logs.push(line), error: (line) => calls.errors.push(line) });
  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error, 'connection access denied');
  assert.equal(calls.quota, 0);
  assert.equal(calls.kv, 0);
  assert.equal(calls.fetch, 0);
});

test('allowed Azure injection is outbound-only, redacted from logs and identity is not forwarded', async () => {
  const { handler, calls } = loadBroker();
  global.fetch = async (url, options) => {
    calls.fetch++;
    calls.outbound = { url, headers: options.headers, body: options.body };
    return { status: 200, arrayBuffer: async () => Buffer.from('{}'), headers: new Map([['content-type', 'application/json']]) };
  };
  const response = await handler(request(), { log: (line) => calls.logs.push(line), error: (line) => calls.errors.push(line) });
  assert.equal(response.status, 200);
  assert.equal(calls.kv, 1);
  assert.equal(calls.outbound.headers['x-api-key'], 'DISTINCTIVE-SECRET-VALUE');
  const secret = 'DISTINCTIVE-SECRET-VALUE';
  const outboundHeaderEntries = Object.entries(calls.outbound.headers);
  const credentialHeaderEntries = outboundHeaderEntries.filter(([, value]) => String(value).includes(secret));
  const secretOccurrences = outboundHeaderEntries.reduce((count, [name, value]) => {
    return count + [name, String(value)].reduce((entryCount, part) => entryCount + part.split(secret).length - 1, 0);
  }, 0);
  assert.deepEqual(credentialHeaderEntries, [['x-api-key', secret]]);
  assert.equal(secretOccurrences, 1);
  const surfaces = [calls.logs, calls.errors, calls.outbound.url, calls.outbound.body, response.headers, response.body, response.jsonBody].map((value) => JSON.stringify(value) ?? '');
  for (const surface of surfaces) assert.equal(surface.includes('DISTINCTIVE-SECRET-VALUE'), false);
  for (const surface of [calls.outbound.url, calls.outbound.headers, calls.outbound.body].map((value) => JSON.stringify(value) ?? '')) {
    assert.equal(surface.includes('DISTINCTIVE-OID'), false);
    assert.equal(surface.includes('DISTINCTIVE-AZP'), false);
  }
});

test('Entra injection remains Key-Vault-free', async () => {
  const { handler, calls } = loadBroker({ inject: 'entra' });
  global.fetch = async (url, options) => {
    calls.fetch++;
    calls.outbound = { url, headers: options.headers };
    return { status: 200, arrayBuffer: async () => Buffer.from('{}'), headers: new Map([['content-type', 'application/json']]) };
  };
  const response = await handler(request(), { log: (line) => calls.logs.push(line), error: (line) => calls.errors.push(line) });
  assert.equal(response.status, 200);
  assert.equal(calls.kv, 0);
  assert.deepEqual(calls.scopes, ['https://vendor.test/.default']);
  assert.equal(calls.outbound.headers.authorization, 'Bearer managed-token');
});
