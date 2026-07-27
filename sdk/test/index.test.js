'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const sdk = require('..');

test('normalizes and validates HTTPS issuers', () => {
  assert.equal(sdk.normalizeIssuer('https://issuer.test///'), 'https://issuer.test');
  assert.equal(sdk.requireHttpsIssuer('https://issuer.test/', () => { throw new Error('invalid'); }), 'https://issuer.test');
  assert.throws(() => sdk.requireHttpsIssuer('http://issuer.test', () => { throw new Error('invalid'); }), /invalid/);
});

test('provides strict JSON and immutable contract utilities', () => {
  assert.equal(sdk.canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  const value = sdk.deepFreeze({ nested: { value: 1 } });
  assert(Object.isFrozen(value.nested));
  assert.throws(() => sdk.requireObject([], () => { throw new Error('object'); }), /object/);
  assert.throws(() => sdk.rejectUnknownKeys({ extra: 1 }, new Set(), (key) => { throw new Error(key); }), /extra/);
});
