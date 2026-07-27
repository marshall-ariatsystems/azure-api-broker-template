'use strict';

// Exercise the registered broker boundary, not merely the pure preflight helper.
const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const BROKER = path.join(__dirname, '..', 'src', 'broker.js');

function load() {
  process.env.KEYVAULT_URI = 'https://kv.test.vault.azure.net';
  process.env.ROLE_SECRET_MAP = JSON.stringify({ 'VendorApi.Test.Invoke': { secret: 'private-slot', route: 'test', baseUrl: 'https://vendor.test' } });
  delete process.env.AUTH_MODE;
  delete require.cache[require.resolve(BROKER)];
  const handlers = {}; const calls = { kv: 0, vendor: 0, oauth: 0 };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '@azure/functions') return { app: { http: (name, options) => { handlers[name] = options; } } };
    if (request === '@azure/identity') return { DefaultAzureCredential: class { async getToken() { calls.oauth++; return { token: 'must-not-be-used' }; } } };
    if (request === '@azure/keyvault-secrets') return { SecretClient: class { async getSecret() { calls.kv++; return { value: 'must-not-be-used' }; } } };
    if (request === '@azure/data-tables') return { TableClient: class {} };
    return originalLoad.call(this, request, ...rest);
  };
  try { require(BROKER); } finally { Module._load = originalLoad; }
  global.fetch = async () => { calls.vendor++; throw new Error('preflight must not fetch a vendor'); };
  return { handlers, calls };
}

function request(routeSlug, roles = ['VendorApi.Test.Invoke'], oid = 'DISTINCTIVE-OID') {
  const principal = Buffer.from(JSON.stringify({ claims: [
    ...roles.map((val) => ({ typ: 'roles', val })), { typ: 'oid', val: oid }, { typ: 'azp', val: 'DISTINCTIVE-AZP' },
  ] })).toString('base64');
  return { params: { routeSlug }, headers: new Map([['x-ms-client-principal', principal], ['x-correlation-id', 'client-correlation-0001']]) };
}

test('HTTP preflight authorizes and categorically denies without KV, vendor, or OAuth work', async () => {
  const { handlers, calls } = load();
  assert.equal(handlers.preflight.route, 'broker/preflight/{routeSlug}');
  const handler = handlers.preflight.handler;
  const grants = JSON.stringify({ version: 1, connections: [{ id: 'azure:test', subjects: ['user:DISTINCTIVE-OID'] }] });
  const ctx = { logs: [], log(line) { this.logs.push(line); } };
  const invoke = (req, raw = grants) => handler(req, ctx, { readConnectionGrants: () => raw, idSource: { next: () => 'generated-correlation-0001' } });

  const allowed = await invoke(request('test'));
  const roleDenied = await invoke(request('test', ['VendorApi.Other.Invoke']));
  const routeDenied = await invoke(request('missing'));
  const grantDenied = await invoke(request('test'), JSON.stringify({ version: 1, connections: [{ id: 'azure:test', subjects: ['user:other'] }] }));

  assert.deepEqual(allowed.jsonBody, { status: 200, correlationId: 'client-correlation-0001', subjectType: 'user', route: 'test', authorization: 'allowed' });
  for (const [response, authorization] of [[roleDenied, 'role-denied'], [routeDenied, 'route-denied'], [grantDenied, 'grant-denied']]) {
    assert.equal(response.status, 403); assert.equal(response.jsonBody.authorization, authorization);
    assert.equal(Object.hasOwn(response.jsonBody, 'route'), false);
  }
  for (const response of [allowed, roleDenied, routeDenied, grantDenied]) {
    assert.deepEqual(Object.keys(response.jsonBody).filter((key) => !['status', 'correlationId', 'subjectType', 'route', 'authorization'].includes(key)), []);
    assert.equal(JSON.stringify(response).includes('DISTINCTIVE-OID'), false);
  }
  assert.deepEqual(calls, { kv: 0, vendor: 0, oauth: 0 });
  assert.equal(ctx.logs.every((line) => !line.includes('DISTINCTIVE-OID')), true);
});
