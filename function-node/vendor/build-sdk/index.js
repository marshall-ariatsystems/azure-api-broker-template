'use strict';

// This package deliberately has no runtime dependencies. It is usable from
// both CommonJS services and ESM bridge code (via a default import).
function requireObject(value, onInvalid) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) onInvalid();
  return value;
}

function rejectUnknownKeys(value, allowed, onUnknown) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) onUnknown(key);
}

function normalizeIssuer(value) {
  return String(value).replace(/\/+$/, '');
}

function requireHttpsIssuer(value, onInvalid) {
  const issuer = normalizeIssuer(value);
  let url;
  try { url = new URL(issuer); } catch { onInvalid(); }
  if (!url || url.protocol !== 'https:' || !url.hostname) onInvalid();
  return issuer;
}

function canonicalJson(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('canonical JSON requires plain JSON');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Header policy shared by the bridge and broker. Callers must never provide a
// vendor credential, and connection-scoped headers must never cross a proxy
// boundary. Keep the names here so the two boundaries cannot drift.
const CREDENTIAL_HEADER_NAMES = Object.freeze(new Set([
  'authorization', 'x-api-key', 'api-key', 'apikey', 'api_key', 'subscription-key',
  'access_token', 'token', 'client_id', 'client_secret', 'x-api-secret', 'x-key-id',
  'x-secret', 'key', 'x-api-key-id',
]));
const HOP_BY_HOP_HEADER_NAMES = Object.freeze(new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length',
  'proxy-authorization', 'proxy-authenticate',
]));

function isSensitiveRequestHeader(name) {
  const normalized = String(name).toLowerCase();
  return CREDENTIAL_HEADER_NAMES.has(normalized) || HOP_BY_HOP_HEADER_NAMES.has(normalized);
}

function isBlockedRequestHeader(name) {
  const normalized = String(name).toLowerCase();
  return isSensitiveRequestHeader(normalized) || normalized.startsWith('x-ms-');
}

module.exports = {
  CREDENTIAL_HEADER_NAMES,
  HOP_BY_HOP_HEADER_NAMES,
  canonicalJson,
  deepFreeze,
  isBlockedRequestHeader,
  isSensitiveRequestHeader,
  normalizeIssuer,
  rejectUnknownKeys,
  requireHttpsIssuer,
  requireObject,
};
