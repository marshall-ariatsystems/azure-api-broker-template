'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildRouteTable, slugForRole } = require('../src/role-routing');
const { createAzureReferenceAdapter } = require('../src/azure-reference-adapter');
const fixtures = require('./role-routing-fixtures');

test('broker and adapter derive identical routes', () => {
  const brokerRoutes = buildRouteTable(fixtures.ROLE_MAP);
  const adapter = createAzureReferenceAdapter(fixtures.ROLE_MAP);
  assert.deepEqual({ ...brokerRoutes.slugToRole }, fixtures.EXPECTED_SLUG_TO_ROLE);
  assert.deepEqual(adapter.connectionIds, fixtures.EXPECTED_CONNECTION_IDS);
  for (const [role, entry] of Object.entries(fixtures.ROLE_MAP)) {
    assert.equal(`azure:${slugForRole(role, entry)}`, adapter.connectionIds.find((id) => id === `azure:${slugForRole(role, entry)}`));
    assert.equal(brokerRoutes.slugToRole[slugForRole(role, entry)], role);
  }
});

test('ambiguous role map rejected', () => {
  assert.throws(() => buildRouteTable(fixtures.AMBIGUOUS_ROLE_MAP), (error) => {
    assert.match(error.message, /ambiguous role routing/);
    for (const secret of ['vendor-key-graph', 'vendor-key-graph-alt', 'graph']) assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(buildRouteTable(fixtures.ROLE_MAP).slugToRole.unknown, undefined);
});

test('only role-routing defines slugForRole', () => {
  const sourceDir = path.join(__dirname, '..', 'src');
  const definitions = fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.js'))
    .flatMap((name) => (fs.readFileSync(path.join(sourceDir, name), 'utf8').match(/function slugForRole/g) || []).map(() => name));
  assert.deepEqual(definitions, ['role-routing.js']);
});
