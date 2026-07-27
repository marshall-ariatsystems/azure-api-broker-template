import assert from 'node:assert/strict';
import test from 'node:test';
import { requestWithRetry } from '../broker-retry.mjs';

// A fake HTTP response factory (no network). headers is a Map-like with .get().
function makeResponse({ status, retryAfter, correlationId, extraHeaders = {} }) {
  const h = new Map(Object.entries({
    ...(retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}),
    ...(correlationId !== undefined ? { 'x-correlation-id': correlationId } : {}),
    ...extraHeaders,
  }));
  return Object.freeze({ status, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null } });
}
// Injected clock + sleep: sleep records the ms it was asked to wait; clock advances by that much.
function createClock() {
  let nowMs = 0; const waits = [];
  return Object.freeze({ now: () => nowMs, waits, sleep: async (ms) => { waits.push(ms); nowMs += ms; } });
}
// Injected jitter source: deterministic, bounded to the ceiling.
function createJitter(values = [50, 50, 50]) { let i = 0; return Object.freeze({ next: (ceilMs) => Math.min(values[i++ % values.length], ceilMs) }); }
const OK        = makeResponse({ status: 200, correlationId: 'req-01HZ_client.abc-0001' });
const RATE_429  = makeResponse({ status: 429, retryAfter: 30, correlationId: 'req-01HZ_client.abc-0002' });
const RATE_NOHDR= makeResponse({ status: 429, correlationId: 'req-01HZ_client.abc-0003' }); // no Retry-After
// A 429 whose headers carry credential/vendor-internal markers that must NOT surface.
const RATE_LEAK = makeResponse({ status: 429, retryAfter: 30, correlationId: 'req-01HZ_client.abc-0004',
  extraHeaders: { authorization: 'Bearer DISTINCTIVE-CRED', 'x-vendor-note': 'DISTINCTIVE-VENDOR' } });
const DEFAULT_POLICY = { maxRetries: 3, jitterCeilingMs: 100, defaultRetryAfterSeconds: 5 };
const FORBIDDEN_TOPOLOGY = [
  ['func-broker-cxapi-csb2cscrdcdka3fy.', 'centralus-01.azurewebsites.net'].join(''),
  ['10.0.0.', '10'].join(''),
  ['ce485d55-f7af-40a8-', 'b9d3-12dd64252740'].join(''),
];

test('retry-after is authoritative', async () => {
  const clock = createClock();
  const jitter = createJitter([50]);
  const responses = [RATE_429, OK];
  const result = await requestWithRetry({
    doFetch: async () => responses.shift(), request: { idempotent: true }, policy: DEFAULT_POLICY, clock, jitter,
  });

  assert.equal(clock.waits[0], 30 * 1000 + 50);
  assert.equal(result.retryAfterSeconds, 30);
  assert.equal(result.attempts, 2);
});

test('idempotent read retries bounded', async () => {
  const clock = createClock();
  const result = await requestWithRetry({
    doFetch: async () => RATE_429, request: { idempotent: true }, policy: DEFAULT_POLICY, clock, jitter: createJitter(),
  });

  assert.equal(result.attempts, DEFAULT_POLICY.maxRetries + 1);
  assert.equal(clock.waits.length, DEFAULT_POLICY.maxRetries);
  assert.equal(result.status, 429);
});

test('write is single attempt by default', async () => {
  const clock = createClock();
  const result = await requestWithRetry({
    doFetch: async () => RATE_429, request: {}, policy: DEFAULT_POLICY, clock, jitter: createJitter(),
  });

  assert.equal(result.attempts, 1);
  assert.equal(clock.waits.length, 0);
});

test('write retry needs idempotency and status check', async () => {
  const noRetryClock = createClock();
  let executedChecks = 0;
  const executed = await requestWithRetry({
    doFetch: async () => RATE_429,
    request: { idempotencyKey: 'test-key' }, policy: DEFAULT_POLICY, clock: noRetryClock, jitter: createJitter(),
    checkExecutionStatus: async () => { executedChecks += 1; return 'executed'; },
  });
  assert.equal(executed.attempts, 1);
  assert.equal(executedChecks, 1);
  assert.equal(noRetryClock.waits.length, 0);

  const events = [];
  const responses = [RATE_429, OK];
  const retried = await requestWithRetry({
    doFetch: async () => { events.push('fetch'); return responses.shift(); },
    request: { idempotencyKey: 'test-key' }, policy: DEFAULT_POLICY, clock: createClock(), jitter: createJitter(),
    checkExecutionStatus: async () => { events.push('check'); return 'not-executed'; },
  });
  assert.equal(retried.attempts, 2);
  assert.deepEqual(events, ['fetch', 'check', 'fetch']);
});

test('rate-limit result is redacted', async () => {
  const leakResult = await requestWithRetry({
    doFetch: async () => RATE_LEAK, request: {}, policy: DEFAULT_POLICY, clock: createClock(), jitter: createJitter(),
  });
  assert.deepEqual(Object.keys(leakResult), ['status', 'retryAfterSeconds', 'correlationId', 'attempts']);
  const serialized = JSON.stringify(leakResult);
  for (const prohibited of ['DISTINCTIVE-CRED', 'DISTINCTIVE-VENDOR', ...FORBIDDEN_TOPOLOGY]) {
    assert.equal(serialized.includes(prohibited), false);
  }

  const clock = createClock();
  const fallback = await requestWithRetry({
    doFetch: async () => RATE_NOHDR, request: { idempotent: true }, policy: DEFAULT_POLICY, clock, jitter: createJitter(),
  });
  assert.equal(fallback.retryAfterSeconds, DEFAULT_POLICY.defaultRetryAfterSeconds);
  assert.equal(fallback.attempts, DEFAULT_POLICY.maxRetries + 1);
  assert.deepEqual(clock.waits, [5050, 5050, 5050]);
});
