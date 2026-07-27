'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateDeploymentChain } = require('../src/ninjaone-deployment-chain');
const fixtures = require('./ninjaone-provider-fixtures');

function safe(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const forbidden of [...fixtures.FORBIDDEN_TOPOLOGY, fixtures.ROLE, fixtures.ROLE_SECRET_MAP[fixtures.ROLE].secret]) assert.equal(text.includes(forbidden), false);
}

test('complete chain validates', () => {
  const result = validateDeploymentChain(fixtures.COMPLETE_CHAIN);
  assert.deepEqual(result, { ok: true, route: 'ninjaone' });
  assert(Object.isFrozen(result));
  safe(result);
});

test('missing link diagnosed', () => {
  const wrongRoute = Object.freeze({ ...fixtures.ROLE_SECRET_MAP, [fixtures.ROLE]: Object.freeze({ ...fixtures.ROLE_SECRET_MAP[fixtures.ROLE], route: 'other' }) });
  const secretless = Object.freeze({ ...fixtures.ROLE_SECRET_MAP, [fixtures.ROLE]: Object.freeze({ ...fixtures.ROLE_SECRET_MAP[fixtures.ROLE], secret: '' }) });
  const noGrant = JSON.stringify({ version: 1, connections: [] });
  const cases = [
    ['role', { ...fixtures.COMPLETE_CHAIN, assignedRoles: Object.freeze([]) }],
    ['route', { ...fixtures.COMPLETE_CHAIN, roleSecretMap: wrongRoute }],
    ['role-secret-map', { ...fixtures.COMPLETE_CHAIN, roleSecretMap: Object.freeze({}) }],
    ['secret-slot', { ...fixtures.COMPLETE_CHAIN, roleSecretMap: secretless }],
    ['connection-grant', { ...fixtures.COMPLETE_CHAIN, connectionGrantsJson: noGrant }],
  ];
  for (const [missing, input] of cases) {
    const result = validateDeploymentChain(input);
    assert.deepEqual(result, { ok: false, missing });
    safe(result);
  }
  for (const malformed of [undefined, {}, { ...fixtures.COMPLETE_CHAIN, connectionGrantsJson: '{' }]) {
    assert.throws(() => validateDeploymentChain(malformed), (error) => { safe(error.message); return error instanceof TypeError; });
  }
});
