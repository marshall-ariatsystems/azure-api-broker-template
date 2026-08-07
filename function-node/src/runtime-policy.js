'use strict';

const { AppConfigurationClient } = require('@azure/app-configuration');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const { normalizeEndpointPolicy } = require('./endpoint-policy');

const PREFIX = process.env.POLICY_KEY_PREFIX || 'broker';
const ROLE_MAP_KEY = `${PREFIX}:role-map`;
const GRANTS_KEY = `${PREFIX}:connection-grants`;
const MAX_BYTES = 64 * 1024;

function parse(value, name) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw new TypeError(`${name} policy is invalid`);
  try { return JSON.parse(value); } catch { throw new TypeError(`${name} policy is invalid`); }
}
function validRoleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) throw new TypeError('role map policy is invalid');
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

function createRuntimePolicy({ endpoint = process.env.APP_CONFIG_ENDPOINT, storageAccount = process.env.POLICY_STORAGE_ACCOUNT, tableName = process.env.POLICY_TABLE_NAME || 'brokerPolicy', cacheSeconds = process.env.POLICY_CACHE_TTL_SECONDS || '15', credential = new DefaultAzureCredential(), client } = {}) {
  if (!endpoint && !storageAccount && !client) return Object.freeze({ enabled: false, async read() { return null; } });
  if (endpoint && !/^https:\/\//.test(endpoint)) throw new TypeError('APP_CONFIG_ENDPOINT is invalid');
  if (storageAccount && !/^[a-z0-9]{3,24}$/.test(storageAccount)) throw new TypeError('POLICY_STORAGE_ACCOUNT is invalid');
  const ttl = Number(cacheSeconds);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300) throw new TypeError('POLICY_CACHE_TTL_SECONDS is invalid');
  const mode = storageAccount ? 'table' : 'appconfig';
  const policyClient = client || (mode === 'table'
    ? new TableClient(`https://${storageAccount}.table.core.windows.net`, tableName, credential)
    : new AppConfigurationClient(endpoint, credential));
  let cached = null;
  return Object.freeze({
    enabled: true,
    async read() {
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      let roleValue; let grantValue;
      if (mode === 'table') {
        const [roleEntity, grantEntity] = await Promise.all([
          policyClient.getEntity('policy', ROLE_MAP_KEY).catch((error) => error.statusCode === 404 ? null : Promise.reject(error)),
          policyClient.getEntity('policy', GRANTS_KEY).catch((error) => error.statusCode === 404 ? null : Promise.reject(error)),
        ]);
        roleValue = roleEntity ? parse(roleEntity.document, 'role map') : {};
        grantValue = grantEntity ? parse(grantEntity.document, 'grant') : { schemaVersion: 1, version: 1, connections: [] };
      } else {
        const [roleSetting, grantSetting] = await Promise.all([
          policyClient.getConfigurationSetting({ key: ROLE_MAP_KEY }),
          policyClient.getConfigurationSetting({ key: GRANTS_KEY }),
        ]);
        roleValue = parse(roleSetting.value, 'role map'); grantValue = parse(grantSetting.value, 'grant');
      }
      const value = Object.freeze({ roleMap: validRoleMap(roleValue), grantsJson: JSON.stringify(validGrants(grantValue)) });
      cached = { value, expiresAt: Date.now() + ttl * 1000 };
      return value;
    },
  });
}

module.exports = { createRuntimePolicy, ROLE_MAP_KEY, GRANTS_KEY };
