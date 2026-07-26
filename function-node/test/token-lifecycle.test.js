'use strict';
const assert = require('node:assert/strict'); const test = require('node:test');
const { createEvidenceRegistry, createVendorTokenLifecycle, createRecoveryGuard } = require('../src/token-lifecycle');
const { hardwareKeyEvidence, createTestClock } = require('./runtime-assurance-fixtures');
test('replayed evidence denied', () => {
  const registry = createEvidenceRegistry(); const clock = createTestClock();
  assert.deepEqual(registry.assertFresh(hardwareKeyEvidence, { clock }), { ok: true });
  assert.deepEqual(registry.assertFresh(hardwareKeyEvidence, { clock }), { ok: false, reason: 'evidence-replayed' });
  clock.advance(3600000); assert.deepEqual(createEvidenceRegistry().assertFresh(hardwareKeyEvidence, { clock }), { ok: false, reason: 'evidence-expired' });
});
test('bounded 401 re-mint', async () => {
  const clock = createTestClock(); let calls = 0; const lifecycle = createVendorTokenLifecycle({ clock, mint: async () => ({ token: `DISTINCTIVE-VENDOR-TOKEN-${++calls}`, expiresInSeconds: 61 }) });
  assert.equal(await lifecycle.getToken('orders'), 'DISTINCTIVE-VENDOR-TOKEN-1'); assert.equal(await lifecycle.getToken('orders'), 'DISTINCTIVE-VENDOR-TOKEN-1');
  const guard = createRecoveryGuard(); assert(guard.attemptRemint()); assert.equal(await lifecycle.getToken('orders', { forceRefresh: true }), 'DISTINCTIVE-VENDOR-TOKEN-2'); assert.equal(guard.attemptRemint(), false); assert.equal(calls, 2);
  clock.advance(2000); assert.equal(await lifecycle.getToken('orders'), 'DISTINCTIVE-VENDOR-TOKEN-3');
  assert(!JSON.stringify([createEvidenceRegistry().assertFresh(hardwareKeyEvidence, { clock: createTestClock() }), guard.attemptRemint()]).includes('DISTINCTIVE-VENDOR-TOKEN'));
});
