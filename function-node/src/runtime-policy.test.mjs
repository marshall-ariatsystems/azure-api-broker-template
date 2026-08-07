import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRuntimePolicy, ROLE_MAP_KEY, GRANTS_KEY } = require('./runtime-policy.js');

test('table-backed runtime policy reads role and grant documents', async () => {
  const entities = new Map([
    [ROLE_MAP_KEY, { document: JSON.stringify({ 'VendorApi.Example.Invoke': { secret: 'example-key', baseUrl: 'https://api.example.test', inject: 'header' } }) }],
    [GRANTS_KEY, { document: JSON.stringify({ schemaVersion: 1, version: 1, connections: [] }) }],
  ]);
  const policy = createRuntimePolicy({ storageAccount: 'exampleaccount', client: { getEntity: async (_partition, key) => entities.get(key) }, cacheSeconds: '15' });
  const current = await policy.read();
  assert.equal(current.roleMap['VendorApi.Example.Invoke'].secret, 'example-key');
  assert.equal(JSON.parse(current.grantsJson).schemaVersion, 1);
});

test('missing table documents produce a fail-closed empty policy', async () => {
  const missing = Object.assign(new Error('missing'), { statusCode: 404 });
  const policy = createRuntimePolicy({ storageAccount: 'exampleaccount', client: { getEntity: async () => { throw missing; } } });
  const current = await policy.read();
  assert.deepEqual(current.roleMap, {});
  assert.deepEqual(JSON.parse(current.grantsJson).connections, []);
});
