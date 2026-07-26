'use strict';

// Small dependency-free primitives for fail-closed JSON document parsers.
// Callers retain their own error vocabulary by supplying the failure callback.
function requireObject(value, onInvalid) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) onInvalid();
  return value;
}

function rejectUnknownKeys(value, allowed, onUnknown) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) onUnknown(key);
  }
}

module.exports = { requireObject, rejectUnknownKeys };
