const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const grantsApi = require('../src/connection-grants');
const BROKER = path.join(__dirname, '..', 'src', 'broker.js');
const connection = Object.freeze({ id: 'azure:orders', provider: 'azure-reference', baseUrl: 'https://vendor.test', injection: 'header' });
const userIdentity = Object.freeze({ subject: 'user:alice', groups: Object.freeze(['group:ops']) });
const workloadIdentity = Object.freeze({ subject: 'workload:deploy', workload: 'workload:deploy' });
const grants = Object.freeze({ version: 1, connections: Object.freeze([
  Object.freeze({ id: 'azure:orders', subjects: Object.freeze(['user:alice']), groups: Object.freeze(['group:ops']), workloads: Object.freeze(['workload:deploy']) }),
]) });
const knownConnectionIds = Object.freeze(['azure:orders']);

test('grant parser accepts frozen public schema and rejects forbidden shaped data', () => {
  const parsed = grantsApi.parseConnectionGrants(JSON.stringify(grants), { knownConnectionIds });
  assert(Object.isFrozen(parsed));
  assert(Object.isFrozen(parsed.connections));
  assert(Object.isFrozen(parsed.connections[0]));
  const invalid = [undefined, '', '{', 'x'.repeat(65537),
    JSON.stringify({ version: 1, connections: [{ ...grants.connections[0], id: 'azure:other' }] }),
    JSON.stringify({ version: 1, connections: [{ ...grants.connections[0], scope: 'no' }] }),
    JSON.stringify({ version: 1, connections: [{ ...grants.connections[0], operations: ['no'] }] }),
    JSON.stringify({ version: 1, connections: [{ ...grants.connections[0], secret: 'no' }] }),
    JSON.stringify({ version: 1, connections: [{ ...grants.connections[0], subjects: ['user:*'] }] }),
    JSON.stringify({ version: 1, connections: [{ id: 'azure:orders' }] }),
    JSON.stringify({ version: 1, connections: [grants.connections[0], grants.connections[0]] }),
  ];
  for (const raw of invalid) assert.throws(() => grantsApi.parseConnectionGrants(raw, { knownConnectionIds }));
  assert.throws(() => grantsApi.parseConnectionGrants(JSON.stringify(grants), { knownConnectionIds: ['azure:orders'] }));
});

test('grant evaluator permits user group workload and denies malformed or unmatched identity', () => {
  assert.deepEqual(grantsApi.authorizeGrant({ identity: userIdentity, connection, grants }), { allowed: true, reason: 'allowed' });
  assert.deepEqual(grantsApi.authorizeGrant({ identity: { subject: 'user:nobody' }, connection, grants }), { allowed: false, reason: 'denied' });
  assert.equal(grantsApi.authorizeGrant({ identity: { subject: 'user:bob', groups: ['group:ops'] }, connection, grants }).allowed, true);
  assert.equal(grantsApi.authorizeGrant({ identity: workloadIdentity, connection, grants }).allowed, true);
  for (const identity of [{ subject: 'user:alice', groups: ['ops'] }, { subject: 'user:alice', workload: 'deploy' }, {}]) {
    assert.throws(() => grantsApi.normalizeGrantIdentity(identity));
  }
});

test('forbidden scope or operation fields reject on every grant API', () => {
  assert.throws(() => grantsApi.parseConnectionGrants(JSON.stringify({ version: 1, connections: [], scope: 'x' }), { knownConnectionIds }));
  assert.throws(() => grantsApi.normalizeGrantIdentity({ subject: 'user:alice', operation: 'read' }));
  assert.throws(() => grantsApi.authorizeGrant({ identity: userIdentity, connection, grants, scope: 'x' }));
  const result = grantsApi.authorizeGrant({ identity: userIdentity, connection, grants });
  assert.equal(Object.hasOwn(result, 'scope'), false);
  assert.equal(Object.hasOwn(result, 'operations'), false);
});

function loadBroker() {
  process.env.KEYVAULT_URI = 'https://kv.vault.azure.net/';
  process.env.ROLE_SECRET_MAP = JSON.stringify({ 'VendorApi.Orders.Invoke': { secret: 'orders-key', baseUrl: 'https://vendor.test', inject: 'header' } });
  process.env.QUOTA_CALLER_PER_MIN = '1000'; process.env.QUOTA_KEY_PER_MIN = '1000';
  process.env.RATE_LIMIT_FAIL_MODE = 'open'; process.env.RATE_LIMIT_STORAGE_ACCOUNT = 'teststorage';
  delete require.cache[require.resolve(BROKER)];
  delete require.cache[require.resolve('../src/azure-reference-adapter')];
  const calls = { quota: 0, kv: 0, token: 0, fetch: 0, outbound: null, logs: [] };
  const original = Module._load;
  Module._load = function(request, ...args) {
    if (request === '@azure/functions') return { app: { http() {} } };
    if (request === '@azure/identity') return { DefaultAzureCredential: class { async getToken() { calls.token++; return { token: 'managed-token' }; } } };
    if (request === '@azure/keyvault-secrets') return { SecretClient: class { async getSecret() { calls.kv++; return { value: 'DISTINCTIVE-SECRET' }; } } };
    if (request === '@azure/data-tables') return { TableClient: class { async createTable() {} async createEntity() {} async getEntity() { calls.quota++; throw { statusCode: 404, code: 'ResourceNotFound' }; } async updateEntity() {} } };
    return original.call(this, request, ...args);
  };
  let broker;
  try { broker = require(BROKER); } finally { Module._load = original; }
  return { broker, calls };
}
function request() {
  const principal = Buffer.from(JSON.stringify({ claims: [{ typ: 'roles', val: 'VendorApi.Orders.Invoke' }, { typ: 'oid', val: 'alice-distinctive' }] })).toString('base64');
  return { method: 'GET', params: { path: 'orders' }, query: new URLSearchParams(), headers: new Map([['x-ms-client-principal', principal]]), arrayBuffer: async () => new ArrayBuffer(0) };
}
function grantDocument(entry = { id: 'azure:orders', subjects: ['user:alice-distinctive'] }) { return JSON.stringify({ version: 1, connections: [entry] }); }

test('broker grant gate audit excludes normalized identity and secrets from vendor forwarding', async () => {
  for (const [document, evidence] of [[grantDocument(), undefined], [grantDocument({ id: 'azure:orders', groups: ['group:ops-distinctive'] }), () => ({ groups: ['group:ops-distinctive'] })], [grantDocument({ id: 'azure:orders', workloads: ['workload:deploy-distinctive'] }), () => ({ workload: 'workload:deploy-distinctive' })]]) {
    const { broker, calls } = loadBroker();
    global.fetch = async (url, options) => { calls.fetch++; calls.outbound = { url, headers: options.headers, body: options.body }; return { status: 200, arrayBuffer: async () => Buffer.from('{}'), headers: new Map([['content-type', 'application/json']]) }; };
    const response = await broker.createBrokerHandler({ readConnectionGrants: () => document, normalizedEvidence: evidence })(request(), { log: (line) => calls.logs.push(line), error() {} });
    assert.equal(response.status, 200);
    const outbound = JSON.stringify(calls.outbound);
    for (const forbidden of ['alice-distinctive', 'group:ops-distinctive', 'workload:deploy-distinctive', 'scope', 'operations']) assert.equal(outbound.includes(forbidden), false);
    assert.equal(calls.outbound.headers['x-api-key'], 'DISTINCTIVE-SECRET');
    const audit = calls.logs.find((line) => line.includes('grant connection='));
    assert.match(audit, /connection=azure:orders grant=allowed/);
    for (const secret of ['alice-distinctive', 'group:ops-distinctive', 'workload:deploy-distinctive', document, 'DISTINCTIVE-SECRET']) assert.equal(audit.includes(secret), false);
  }
});

test('broker denied grants cause zero side effects', async () => {
  for (const document of [undefined, grantDocument({ id: 'azure:orders', subjects: ['user:other'] }), grantDocument({ id: 'azure:orders', groups: ['group:other'] })]) {
    const { broker, calls } = loadBroker(); global.fetch = async () => { calls.fetch++; throw new Error('must not fetch'); };
    const response = await broker.createBrokerHandler({ readConnectionGrants: () => document })(request(), { log: (line) => calls.logs.push(line), error() {} });
    assert.deepEqual(response, { status: 403, jsonBody: { error: 'connection access denied' } });
    assert.deepEqual([calls.quota, calls.kv, calls.token, calls.fetch], [0, 0, 0, 0]);
  }
});

test('revoked next request', async () => {
  const { broker, calls } = loadBroker(); let current = grantDocument();
  global.fetch = async () => { calls.fetch++; return { status: 200, arrayBuffer: async () => Buffer.from('{}'), headers: new Map([['content-type', 'application/json']]) }; };
  const handler = broker.createBrokerHandler({ readConnectionGrants: () => current });
  assert.equal((await handler(request(), { log() {}, error() {} })).status, 200);
  current = grantDocument({ id: 'azure:orders', subjects: ['user:revoked'] });
  const denied = await handler(request(), { log() {}, error() {} });
  assert.equal(denied.status, 403);
  assert.equal(calls.fetch, 1);
});
