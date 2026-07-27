'use strict';

const DEFAULT_SECRET_CACHE_TTL_SECONDS = 300;
const MAX_SECRET_CACHE_TTL_SECONDS = 86_400;

function fail(message) {
  throw new TypeError(message);
}

// This is the one canonical role-to-route algorithm shared by broker consumers.
function slugForRole(role, entry) {
  if (entry && typeof entry === 'object' && entry.route) return String(entry.route).toLowerCase();
  const match = /^VendorApi\.(.+)\.Invoke$/i.exec(role);
  return (match ? match[1] : role).toLowerCase();
}

function connectionIdForRole(role, entry) {
  return `azure:${slugForRole(role, entry)}`;
}

function buildRouteTable(roleMap) {
  if (!roleMap || typeof roleMap !== 'object' || Array.isArray(roleMap)) fail('role map must be a plain object');
  const prototype = Object.getPrototypeOf(roleMap);
  if (prototype !== Object.prototype && prototype !== null) fail('role map must be a plain object');

  const slugToRole = Object.create(null);
  const connectionIds = [];
  for (const [role, entry] of Object.entries(roleMap)) {
    const slug = slugForRole(role, entry);
    if (Object.prototype.hasOwnProperty.call(slugToRole, slug)) fail('ambiguous role routing');
    slugToRole[slug] = role;
    connectionIds.push(connectionIdForRole(role, entry));
  }
  return Object.freeze({
    slugToRole: Object.freeze(slugToRole),
    connectionIds: Object.freeze(connectionIds),
  });
}

function parseSecretCacheTtlSeconds(raw) {
  if (raw === undefined || raw === null) return DEFAULT_SECRET_CACHE_TTL_SECONDS;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) throw new Error('invalid SECRET_CACHE_TTL_SECONDS');
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_SECRET_CACHE_TTL_SECONDS) {
    throw new Error('invalid SECRET_CACHE_TTL_SECONDS');
  }
  return seconds;
}

module.exports = Object.freeze({
  slugForRole,
  connectionIdForRole,
  buildRouteTable,
  parseSecretCacheTtlSeconds,
});
