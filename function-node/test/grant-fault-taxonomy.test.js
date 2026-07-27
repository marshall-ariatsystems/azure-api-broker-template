'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');
const f = require('./identity-normalization-fixtures');
const BROKER = path.join(__dirname, '..', 'src', 'broker.js');

function loadBroker() {
  process.env.KEYVAULT_URI = 'https://kv.vault.azure.net/';
  process.env.ROLE_SECRET_MAP = JSON.stringify({ 'VendorApi.Orders.Invoke': { secret: 'orders-key', baseUrl: 'https://vendor.test', inject: 'header' } });
  process.env.QUOTA_CALLER_PER_MIN = '1000'; process.env.QUOTA_KEY_PER_MIN = '1000';
  process.env.RATE_LIMIT_FAIL_MODE = 'open'; process.env.RATE_LIMIT_STORAGE_ACCOUNT = 'teststorage';
  delete require.cache[require.resolve(BROKER)]; delete require.cache[require.resolve('../src/azure-reference-adapter')];
  const calls = { quota: 0, kv: 0, token: 0, vendor: 0, logs: [] };
  const original = Module._load;
  Module._load = function(request, ...args) {
    if (request === '@azure/functions') return { app: { http() {} } };
    if (request === '@azure/identity') return { DefaultAzureCredential: class { async getToken() { calls.token++; return { token: 'managed-token' }; } } };
    if (request === '@azure/keyvault-secrets') return { SecretClient: class { async getSecret() { calls.kv++; return { value: 'secret' }; } } };
    if (request === '@azure/data-tables') return { TableClient: class { async createTable() {} async createEntity() {} async getEntity() { calls.quota++; throw { statusCode: 404 }; } async updateEntity() {} } };
    return original.call(this, request, ...args);
  };
  let broker; try { broker = require(BROKER); } finally { Module._load = original; }
  return { broker, calls };
}
function request() {
  const principal = Buffer.from(JSON.stringify({ claims: [{ typ: 'roles', val: 'VendorApi.Orders.Invoke' }, { typ: 'oid', val: 'caller' }] })).toString('base64');
  return { method: 'GET', params: { path: 'orders' }, query: new URLSearchParams(), headers: new Map([['x-ms-client-principal', principal]]), arrayBuffer: async () => new ArrayBuffer(0) };
}
function validGrant(subject = 'user:other') { return JSON.stringify({ version: 1, connections: [{ id: 'azure:orders', subjects: [subject] }] }); }

test('invalid grant config is not a denial', async () => {
  for (const raw of [f.GRANT_CONFIG_MALFORMED, f.GRANT_CONFIG_OVERSIZE, f.GRANT_CONFIG_WRONG_SCHEMA]) {
    const { broker, calls } = loadBroker();
    global.fetch = async () => { calls.vendor++; throw new Error('vendor must not be called'); };
    const response = await broker.createBrokerHandler({ readConnectionGrants: () => raw })(request(), { log: (line) => calls.logs.push(line), error() {} });
    assert.deepEqual(response, { status: 403, jsonBody: { error: 'connection access denied' } });
    assert.deepEqual([calls.quota, calls.kv, calls.token, calls.vendor], [0, 0, 0, 0]);
    assert.equal(calls.logs.length, 1); assert.match(calls.logs[0], /grant-config-invalid connection=azure:orders/);
    for (const secret of [f.GRANT_CONFIG_MALFORMED, 'DISTINCTIVE-SUBJECT-OID', 'DISTINCTIVE-AZP', 'grant=denied']) assert.equal(calls.logs[0].includes(secret), false);
  }
});

test('valid grant deny is still a denial', async () => {
  const { broker, calls } = loadBroker(); global.fetch = async () => { calls.vendor++; throw new Error('vendor must not be called'); };
  const response = await broker.createBrokerHandler({ readConnectionGrants: () => validGrant() })(request(), { log: (line) => calls.logs.push(line), error() {} });
  assert.deepEqual(response, { status: 403, jsonBody: { error: 'connection access denied' } });
  assert.deepEqual([calls.quota, calls.kv, calls.token, calls.vendor], [0, 0, 0, 0]);
  assert.equal(calls.logs.some((line) => line.includes(f.GRANT_CONFIG_FAULT_CATEGORY)), false);
  assert.equal(calls.logs.some((line) => line.includes(f.DENIAL_OUTCOME)), true);
});
