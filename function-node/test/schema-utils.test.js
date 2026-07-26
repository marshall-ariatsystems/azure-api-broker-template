'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { requireObject, rejectUnknownKeys } = require('../src/schema-utils');

test('schema utilities accept plain objects and reject arrays, null, and unknown keys', () => {
  const value = { known: true };
  assert.equal(requireObject(value, () => { throw new Error('invalid'); }), value);
  for (const invalid of [null, [], 'value']) {
    assert.throws(() => requireObject(invalid, () => { throw new Error('invalid'); }), /invalid/);
  }
  assert.doesNotThrow(() => rejectUnknownKeys(value, new Set(['known']), () => { throw new Error('unknown'); }));
  assert.throws(() => rejectUnknownKeys({ unknown: true }, new Set(['known']), (key) => { throw new Error(key); }), /unknown/);
});
