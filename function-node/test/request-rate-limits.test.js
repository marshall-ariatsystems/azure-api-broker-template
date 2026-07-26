'use strict';
const assert = require('node:assert/strict'); const test = require('node:test');
const { createRequestRateLimiter } = require('../src/request-rate-limits');
const { T0, rateLimitPolicy, createTestClock } = require('./runtime-assurance-fixtures');
test('429 with Retry-After', () => {
  const clock = createTestClock(T0 + 25000); const limiter = createRequestRateLimiter({ ...rateLimitPolicy, clock });
  for (let i = 0; i < 3; i++) assert.deepEqual(limiter.check('alice', 'azure:orders'), { ok: true });
  assert.deepEqual(limiter.check('alice', 'azure:orders'), { ok: false, status: 429, reason: 'identity-quota-exhausted', retryAfterSeconds: 35 });
});
test('connection rejection spares identity and rollover restores allowance', () => {
  const clock = createTestClock(); const limiter = createRequestRateLimiter({ identityPerMinute: 1, connectionPerMinute: 1, clock });
  assert(limiter.check('alice', 'one').ok); assert.equal(limiter.check('bob', 'one').reason, 'connection-quota-exhausted');
  assert(limiter.check('bob', 'two').ok); clock.advance(60000); assert(limiter.check('alice', 'one').ok);
  assert.deepEqual(createRequestRateLimiter({ ...rateLimitPolicy, clock: createTestClock() }).check('a', 'b'), createRequestRateLimiter({ ...rateLimitPolicy, clock: createTestClock() }).check('a', 'b'));
  for (const input of [{}, { identityPerMinute: 0, connectionPerMinute: 1, clock }, { identityPerMinute: 1, connectionPerMinute: 1, clock: {} }]) assert.throws(() => createRequestRateLimiter(input), TypeError);
  assert.throws(() => limiter.check('', 'x'), TypeError);
});
