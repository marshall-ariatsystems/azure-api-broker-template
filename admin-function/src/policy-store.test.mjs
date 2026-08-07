import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PolicyStore, BRANDING_KEY, branding } = require('./policy-store.js');

test('table policy store starts with safe empty versioned documents', async () => {
  const missing = Object.assign(new Error('missing'), { statusCode: 404 });
  const store = new PolicyStore({ client: { getEntity: async () => { throw missing; } } });
  const current = await store.read();
  assert.deepEqual(current.roleMap, {});
  assert.equal(current.grants.schemaVersion, 1);
  assert.equal(current.branding.productName, 'Azure API Broker');
});

test('branding rejects executable and unbounded customization', () => {
  const base = { schemaVersion: 1, productName: 'Contoso Broker', shortName: 'Broker', supportUrl: '', documentationUrl: '', logoUrl: '', faviconUrl: '', colors: { background: '#000000', surface: '#111111', accent: '#0099ff', text: '#ffffff' } };
  assert.equal(branding(base).productName, 'Contoso Broker');
  assert.throws(() => branding({ ...base, html: '<script>' }), /invalid/);
  assert.throws(() => branding({ ...base, logoUrl: 'javascript:alert(1)' }), /invalid/);
  assert.throws(() => branding({ ...base, colors: { ...base.colors, accent: 'red' } }), /invalid/);
});

test('new table branding document is created with a stable policy key', async () => {
  let created;
  const store = new PolicyStore({ client: { createEntity: async (entity) => { created = entity; return {}; } } });
  const value = { schemaVersion: 1, productName: 'Contoso Broker', shortName: 'Broker', supportUrl: '', documentationUrl: '', logoUrl: '', faviconUrl: '', colors: { background: '#000000', surface: '#111111', accent: '#0099ff', text: '#ffffff' } };
  await store.writeBranding(value);
  assert.equal(created.partitionKey, 'policy');
  assert.equal(created.rowKey, BRANDING_KEY);
  assert.equal(JSON.parse(created.document).productName, 'Contoso Broker');
});
