'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { connectionIdForRole } = require('../src/ninjaone-deployment-chain');
const fixtures = require('./ninjaone-provider-fixtures');

test('chain uses runtime slug derivation', () => {
  assert.equal(connectionIdForRole(fixtures.ROLE, fixtures.ROLE_SECRET_MAP[fixtures.ROLE]), fixtures.CONNECTION_ID);
});

test('no shipped topology', () => {
  const root = path.join(__dirname, '..');
  const files = [
    'src/ninjaone-provider-profile.js', 'src/ninjaone-deployment-chain.js',
    'test/ninjaone-provider-fixtures.js', 'test/ninjaone-provider-profile.test.js',
    'test/ninjaone-deployment-chain.test.js', 'test/ninjaone-integration.test.js',
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const literal of fixtures.FORBIDDEN_TOPOLOGY) assert.equal(text.includes(literal), false);
  }
});
