'use strict';

const { AppConfigurationClient } = require('@azure/app-configuration');
const { DefaultAzureCredential } = require('@azure/identity');
const { normalizeEndpointPolicy } = require('./endpoint-policy');

const ROLE_MAP_KEY = 'tessera:broker:role-map';
const GRANTS_KEY = 'tessera:broker:connection-grants';
const MAX_BYTES = 64 * 1024;

function parse(value, name) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw new TypeError(`${name} policy is invalid`);
  try { return JSON.parse(value); } catch { throw new TypeError(`${name} policy is invalid`); }
}
function validRoleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0 || Object.keys(value).length > 128) throw new TypeError('role map policy is invalid');
  for (const [role, entry] of Object.entries(value)) {
    if (typeof role !== 'string' || !role || role.length > 256) throw new TypeError('role map policy is invalid');
    if (typeof entry === 'string' && entry) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.secret !== 'string' || !entry.secret) throw new TypeError('role map policy is invalid');
    if (Object.prototype.hasOwnProperty.call(entry, 'enabled') && typeof entry.enabled !== 'boolean') throw new TypeError('role map policy is invalid');
    if (Object.prototype.hasOwnProperty.call(entry, 'displayName') && (typeof entry.displayName !== 'string' || !entry.displayName || entry.displayName.length > 256)) throw new TypeError('role map policy is invalid');
    if (Object.prototype.hasOwnProperty.call(entry, 'vendor') && (typeof entry.vendor !== 'string' || !entry.vendor || entry.vendor.length > 256)) throw new TypeError('role map policy is invalid');
    if (Object.prototype.hasOwnProperty.call(entry, 'lastRotatedAt') && (typeof entry.lastRotatedAt !== 'string' || Number.isNaN(Date.parse(entry.lastRotatedAt)))) throw new TypeError('role map policy is invalid');
    // Optional per-endpoint lockdown. Validate at load so an operator gets early feedback; a
    // malformed policy is also fail-closed at request time as a second line of defense.
    if (Object.prototype.hasOwnProperty.call(entry, 'endpoints')) {
      try { normalizeEndpointPolicy(entry.endpoints); } catch { throw new TypeError('role map policy is invalid'); }
    }
  }
  return value;
}
function validGrants(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.connections)) throw new TypeError('grant policy is invalid');
  return value;
}

function createRuntimePolicy({ endpoint = process.env.APP_CONFIG_ENDPOINT, cacheSeconds = process.env.POLICY_CACHE_TTL_SECONDS || '15', credential = new DefaultAzureCredential(), client } = {}) {
  if (!endpoint) return Object.freeze({ enabled: false, async read() { return null; } });
  if (!/^https:\/\//.test(endpoint)) throw new TypeError('APP_CONFIG_ENDPOINT is invalid');
  const ttl = Number(cacheSeconds);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300) throw new TypeError('POLICY_CACHE_TTL_SECONDS is invalid');
  const appConfig = client || new AppConfigurationClient(endpoint, credential);
  let cached = null;
  return Object.freeze({
    enabled: true,
    async read() {
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const [roleSetting, grantSetting] = await Promise.all([
        appConfig.getConfigurationSetting({ key: ROLE_MAP_KEY }),
        appConfig.getConfigurationSetting({ key: GRANTS_KEY }),
      ]);
      const value = Object.freeze({ roleMap: validRoleMap(parse(roleSetting.value, 'role map')), grantsJson: JSON.stringify(validGrants(parse(grantSetting.value, 'grant'))) });
      cached = { value, expiresAt: Date.now() + ttl * 1000 };
      return value;
    },
  });
}

module.exports = { createRuntimePolicy, ROLE_MAP_KEY, GRANTS_KEY };
