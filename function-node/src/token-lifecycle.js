'use strict';

function fail() { throw new TypeError('token lifecycle input is invalid'); }
function validClock(clock) { return clock && typeof clock.now === 'function' && Number.isFinite(clock.now()); }

function createEvidenceRegistry() {
  const seen = new Set();
  function assertFresh(claims, { clock } = {}) {
    if (!claims || typeof claims !== 'object' || Array.isArray(claims) || !validClock(clock)) fail();
    const nowSeconds = Math.floor(clock.now() / 1000);
    if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return Object.freeze({ ok: false, reason: 'evidence-expired' });
    if (typeof claims.jti !== 'string' || !claims.jti) fail();
    if (seen.has(claims.jti)) return Object.freeze({ ok: false, reason: 'evidence-replayed' });
    seen.add(claims.jti);
    return Object.freeze({ ok: true });
  }
  return Object.freeze({ assertFresh });
}

function createVendorTokenLifecycle({ mint, clock, skewMs = 60000 } = {}) {
  if (typeof mint !== 'function' || !validClock(clock) || !Number.isFinite(skewMs) || skewMs < 0) fail();
  const cache = new Map();
  async function getToken(name, { forceRefresh = false } = {}) {
    if (typeof name !== 'string' || !name) fail();
    const cached = cache.get(name);
    if (!forceRefresh && cached && cached.exp > clock.now()) return cached.token;
    const minted = await mint(name);
    if (!minted || typeof minted.token !== 'string' || !Number.isFinite(minted.expiresInSeconds)) fail();
    cache.set(name, { token: minted.token, exp: clock.now() + minted.expiresInSeconds * 1000 - skewMs });
    return minted.token;
  }
  return Object.freeze({ getToken });
}

function createRecoveryGuard() {
  let used = false;
  return Object.freeze({ attemptRemint() { if (used) return false; used = true; return true; } });
}

module.exports = { createEvidenceRegistry, createVendorTokenLifecycle, createRecoveryGuard };
