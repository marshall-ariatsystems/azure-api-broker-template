'use strict';
const assert = require('node:assert/strict'); const test = require('node:test');
const { evaluateAssurance } = require('../src/assurance-policy');
const { createRequestRateLimiter } = require('../src/request-rate-limits');
const { createEvidenceRegistry, createVendorTokenLifecycle, createRecoveryGuard } = require('../src/token-lifecycle');
const { resolveStaticKey, resolveByKeyId } = require('../src/static-key-rotation');
const { createAssuranceAudit } = require('../src/assurance-audit');
const fixtures = require('./runtime-assurance-fixtures');

test('runtime assurance composed journey is ordered, bounded, and redacted', async () => {
  const clock = fixtures.createTestClock(); const calls = { rateChecks: 0, keyResolves: 0, vendor: 0, mints: 0 }; const audits = []; const vendorHeaders = [];
  const audit = createAssuranceAudit((record) => audits.push(record)); const limiter = createRequestRateLimiter({ ...fixtures.rateLimitPolicy, clock }); const evidence = createEvidenceRegistry();
  async function journey(claims) {
    const assurance = evaluateAssurance(claims, fixtures.assurancePolicy);
    if (!assurance.sufficient) { audit.record({ at: clock.now(), action: 'assurance.evaluated', outcome: 'denied', reason: assurance.reason }); return { status: 403, reason: assurance.reason }; }
    calls.rateChecks++; const quota = limiter.check('alice', fixtures.connection.id);
    if (!quota.ok) { audit.record({ at: clock.now(), action: 'rate-limit.enforced', outcome: 'denied', reason: quota.reason, retryAfterSeconds: quota.retryAfterSeconds }); return { status: 429, headers: { 'Retry-After': String(quota.retryAfterSeconds) } }; }
    const freshness = evidence.assertFresh(claims, { clock }); if (!freshness.ok) return { status: 401, reason: freshness.reason };
    calls.keyResolves++; const key = resolveStaticKey(fixtures.staticKeyRing, { clock, graceMs: fixtures.ROTATION_GRACE_MS }); calls.vendor++; vendorHeaders.push(key.key.secret);
    audit.record({ at: clock.now(), action: 'assurance.evaluated', outcome: 'allowed', reason: assurance.reason, connectionId: fixtures.connection.id, subjectKind: 'user' }); return { status: 200 };
  }
  const allowed = await journey(fixtures.hardwareKeyEvidence); assert.deepEqual(allowed, { status: 200 }); assert.equal(calls.vendor, 1);
  const before = { ...calls }; const denied = await journey(fixtures.lowerAssuranceEvidence); assert.deepEqual(denied, { status: 403, reason: 'assurance-insufficient' }); assert.equal(calls.rateChecks, before.rateChecks); assert.equal(calls.keyResolves, before.keyResolves); assert.equal(calls.vendor, before.vendor);
  const quotaClaims = { ...fixtures.hardwareKeyEvidence, jti: 'fresh-quota' }; assert.equal((await journey(quotaClaims)).status, 200); assert.equal((await journey({ ...quotaClaims, jti: 'fresh-quota-2' })).status, 200); const throttled = await journey({ ...quotaClaims, jti: 'fresh-quota-3' }); assert.equal(throttled.status, 429); assert.equal(throttled.headers['Retry-After'], '60'); clock.advance(60000); assert.equal((await journey({ ...quotaClaims, jti: 'fresh-after-rollover' })).status, 200);
  const expired = await journey({ ...fixtures.hardwareKeyEvidence, jti: 'expired', exp: Math.floor(clock.now() / 1000) }); assert.deepEqual(expired, { status: 401, reason: 'evidence-expired' }); const replay = await journey({ ...fixtures.hardwareKeyEvidence, jti: 'fresh-after-rollover' }); assert.deepEqual(replay, { status: 401, reason: 'evidence-replayed' });
  const lifecycle = createVendorTokenLifecycle({ clock, mint: async () => ({ token: `DISTINCTIVE-VENDOR-TOKEN-${++calls.mints}`, expiresInSeconds: 3600 }) }); const guard = createRecoveryGuard(); await lifecycle.getToken('orders'); assert(guard.attemptRemint()); await lifecycle.getToken('orders', { forceRefresh: true }); assert.equal(guard.attemptRemint(), false); assert.equal(calls.mints, 2);
  assert.equal(resolveByKeyId(fixtures.staticKeyRing, 'key-2026-06', { clock: fixtures.createTestClock(fixtures.T0 + fixtures.ROTATION_GRACE_MS - 1), graceMs: fixtures.ROTATION_GRACE_MS }).reason, 'key-grace'); assert.equal(resolveByKeyId(fixtures.staticKeyRing, 'key-2026-06', { clock: fixtures.createTestClock(fixtures.T0 + fixtures.ROTATION_GRACE_MS), graceMs: fixtures.ROTATION_GRACE_MS }).reason, 'key-retired');
  const captured = JSON.stringify({ audits, allowed, denied, throttled, expired, replay }); for (const marker of ['DISTINCTIVE-NEW-STATIC-KEY', 'DISTINCTIVE-OLD-STATIC-KEY', 'DISTINCTIVE-VENDOR-TOKEN', 'jti-hardware-0001', 'jti-password-0001', 'alice', 'urn:assurance:', 'hwk']) assert.equal(captured.includes(marker), false); assert.deepEqual(vendorHeaders, ['DISTINCTIVE-NEW-STATIC-KEY', 'DISTINCTIVE-NEW-STATIC-KEY', 'DISTINCTIVE-NEW-STATIC-KEY', 'DISTINCTIVE-NEW-STATIC-KEY']);
});
