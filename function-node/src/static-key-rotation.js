'use strict';

function fail() { throw new TypeError('static key ring is invalid'); }
function validateOptions({ clock, graceMs } = {}) {
  if (!clock || typeof clock.now !== 'function' || !Number.isFinite(clock.now()) || !Number.isFinite(graceMs) || graceMs < 0) fail();
}
function validateRing(ring) {
  if (!Array.isArray(ring) || !Object.isFrozen(ring)) fail();
  for (const record of ring) {
    if (!record || typeof record !== 'object' || !Object.isFrozen(record) || typeof record.keyId !== 'string' || !record.keyId || typeof record.secret !== 'string' || !record.secret) fail();
    for (const time of ['activatedAtMs', 'retiredAtMs']) if (Object.hasOwn(record, time) && !Number.isFinite(record[time])) fail();
  }
}
function resolveStaticKey(ring, options = {}) {
  validateRing(ring); validateOptions(options);
  const active = ring.filter((record) => Number.isFinite(record.activatedAtMs) && record.activatedAtMs <= options.clock.now() && !Object.hasOwn(record, 'retiredAtMs'));
  if (active.length !== 1) fail();
  return Object.freeze({ ok: true, reason: 'key-active', key: active[0] });
}
function resolveByKeyId(ring, keyId, options = {}) {
  validateRing(ring); validateOptions(options);
  if (typeof keyId !== 'string' || !keyId) fail();
  const record = ring.find((item) => item.keyId === keyId);
  if (!record) return Object.freeze({ ok: false, reason: 'key-retired' });
  if (!Object.hasOwn(record, 'retiredAtMs')) return resolveStaticKey(ring, options);
  if (options.clock.now() < record.retiredAtMs + options.graceMs) return Object.freeze({ ok: true, reason: 'key-grace', key: record });
  return Object.freeze({ ok: false, reason: 'key-retired' });
}
module.exports = { resolveStaticKey, resolveByKeyId };
