'use strict';

const MAX_ID_LENGTH = 256;
function fail() { throw new TypeError('rate limit input is invalid'); }
function id(value) { if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH) fail(); return value; }

function createRequestRateLimiter({ identityPerMinute, connectionPerMinute, clock } = {}) {
  if (!Number.isInteger(identityPerMinute) || identityPerMinute < 1 || !Number.isInteger(connectionPerMinute) || connectionPerMinute < 1 || !clock || typeof clock.now !== 'function') fail();
  const counts = new Map();
  function consume(kind, value, window, limit) {
    const key = `${kind}:${window}:${value}`;
    const count = counts.get(key) || 0;
    if (count >= limit) return false;
    counts.set(key, count + 1);
    return true;
  }
  function check(identitySubject, connectionId) {
    id(identitySubject); id(connectionId);
    const now = clock.now();
    if (!Number.isFinite(now)) fail();
    const window = Math.floor(now / 60000);
    const retryAfterSeconds = 60 - (Math.floor(now / 1000) % 60);
    if (!consume('connection', connectionId, window, connectionPerMinute)) return Object.freeze({ ok: false, status: 429, reason: 'connection-quota-exhausted', retryAfterSeconds });
    if (!consume('identity', identitySubject, window, identityPerMinute)) return Object.freeze({ ok: false, status: 429, reason: 'identity-quota-exhausted', retryAfterSeconds });
    return Object.freeze({ ok: true });
  }
  return Object.freeze({ check });
}

module.exports = { createRequestRateLimiter };
