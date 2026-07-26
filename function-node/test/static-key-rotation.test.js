'use strict';
const assert = require('node:assert/strict'); const test = require('node:test');
const { resolveStaticKey, resolveByKeyId } = require('../src/static-key-rotation');
const { T0, ROTATION_GRACE_MS, staticKeyRing, createTestClock } = require('./runtime-assurance-fixtures');
test('rotated static key', () => {
  const active = resolveStaticKey(staticKeyRing, { clock: createTestClock(T0 + 1), graceMs: ROTATION_GRACE_MS });
  assert.equal(active.key.keyId, 'key-2026-07'); assert.equal(active.key.secret, 'DISTINCTIVE-NEW-STATIC-KEY');
  const grace = resolveByKeyId(staticKeyRing, 'key-2026-06', { clock: createTestClock(T0 + ROTATION_GRACE_MS - 1), graceMs: ROTATION_GRACE_MS });
  assert.equal(grace.reason, 'key-grace'); assert.equal(grace.key.secret, 'DISTINCTIVE-OLD-STATIC-KEY'); assert.strictEqual(grace.key, staticKeyRing[0]);
  const retired = resolveByKeyId(staticKeyRing, 'key-2026-06', { clock: createTestClock(T0 + ROTATION_GRACE_MS), graceMs: ROTATION_GRACE_MS });
  assert.deepEqual(retired, { ok: false, reason: 'key-retired' }); assert.equal(Object.hasOwn(retired, 'key'), false);
});
test('static key rings fail closed', () => {
  const clock = createTestClock(); const options = { clock, graceMs: ROTATION_GRACE_MS };
  for (const ring of [[{ keyId: 'x' }], Object.freeze([Object.freeze({ keyId: 'a', secret: 'x', activatedAtMs: 0 }), Object.freeze({ keyId: 'b', secret: 'y', activatedAtMs: 0 })]), Object.freeze([Object.freeze({ keyId: 'a', secret: 'x', activatedAtMs: Infinity })])]) assert.throws(() => resolveStaticKey(ring, options), TypeError);
});
