'use strict';

const { AppConfigurationClient } = require('@azure/app-configuration');
const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');

const PREFIX = process.env.POLICY_KEY_PREFIX || 'broker';
const ROLE_MAP_KEY = `${PREFIX}:role-map`;
const GRANTS_KEY = `${PREFIX}:connection-grants`;
const VENDORS_KEY = `${PREFIX}:vendor-profiles`;
const PRINCIPALS_KEY = `${PREFIX}:principal-profiles`;
const BRANDING_KEY = `${PREFIX}:branding`;
const CONTENT_TYPE = 'application/json';
const MAX_BYTES = 64 * 1024;
const OWN = Object.prototype.hasOwnProperty;
const DEFAULTS = Object.freeze({
  [ROLE_MAP_KEY]: Object.freeze({}),
  [GRANTS_KEY]: Object.freeze({ schemaVersion: 1, version: 1, connections: [] }),
  [VENDORS_KEY]: Object.freeze({ schemaVersion: 1, version: 1, vendors: [] }),
  [PRINCIPALS_KEY]: Object.freeze({ schemaVersion: 1, version: 1, principals: [] }),
  [BRANDING_KEY]: Object.freeze({
    schemaVersion: 1,
    productName: 'Azure API Broker',
    shortName: 'API Broker',
    supportUrl: '',
    documentationUrl: '',
    logoUrl: '',
    faviconUrl: '',
    colors: { background: '#0f1319', surface: '#171d26', accent: '#4da3ff', text: '#dde5ee' },
  }),
});

function fail(message) { throw new TypeError(message); }
function json(value, name) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail(`${name} is invalid`);
  try { return JSON.parse(value); } catch { fail(`${name} is invalid`); }
}
function roleMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) fail('role map is invalid');
  for (const [role, entry] of Object.entries(value)) {
    if (typeof role !== 'string' || !role || role.length > 256) fail('role map is invalid');
    if (typeof entry === 'string' && entry) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.secret !== 'string' || !entry.secret) fail('role map is invalid');
    if (OWN.call(entry, 'enabled') && typeof entry.enabled !== 'boolean') fail('role map is invalid');
    if (OWN.call(entry, 'displayName') && (typeof entry.displayName !== 'string' || !entry.displayName || entry.displayName.length > 256)) fail('role map is invalid');
    if (OWN.call(entry, 'vendor') && (typeof entry.vendor !== 'string' || !entry.vendor || entry.vendor.length > 256)) fail('role map is invalid');
    if (OWN.call(entry, 'lastRotatedAt') && (typeof entry.lastRotatedAt !== 'string' || Number.isNaN(Date.parse(entry.lastRotatedAt)))) fail('role map is invalid');
  }
  return value;
}
function grants(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.connections)) fail('connection grants are invalid');
  return value;
}
function vendors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.vendors) || value.vendors.length > 128) fail('vendor profiles are invalid');
  const ids = new Set();
  for (const vendor of value.vendors) {
    if (!vendor || typeof vendor !== 'object' || Array.isArray(vendor) || typeof vendor.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(vendor.id) || ids.has(vendor.id) || typeof vendor.displayName !== 'string' || !vendor.displayName || vendor.displayName.length > 128) fail('vendor profiles are invalid');
    ids.add(vendor.id);
    for (const field of ['baseUrl', 'documentationUrl']) if (vendor[field] !== undefined && (typeof vendor[field] !== 'string' || vendor[field].length > 512 || !/^https:\/\//.test(vendor[field]))) fail('vendor profiles are invalid');
    if (vendor.authType !== undefined && !['api-key', 'bearer', 'basic', 'oauth2cc', 'entra'].includes(vendor.authType)) fail('vendor profiles are invalid');
  }
  return value;
}
function principals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.principals) || value.principals.length > 1024) fail('principal profiles are invalid');
  const ids = new Set();
  for (const principal of value.principals) {
    if (!principal || typeof principal !== 'object' || Array.isArray(principal) || typeof principal.id !== 'string' || !/^(user|group|workload):[^\s]{1,240}$/.test(principal.id) || ids.has(principal.id) || typeof principal.displayName !== 'string' || !principal.displayName || principal.displayName.length > 256) fail('principal profiles are invalid');
    ids.add(principal.id);
  }
  return value;
}
function branding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) fail('branding is invalid');
  const allowed = ['schemaVersion', 'productName', 'shortName', 'supportUrl', 'documentationUrl', 'logoUrl', 'faviconUrl', 'colors'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('branding is invalid');
  for (const field of ['productName', 'shortName']) if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 80) fail('branding is invalid');
  for (const field of ['supportUrl', 'documentationUrl', 'logoUrl', 'faviconUrl']) {
    if (value[field] !== '' && (typeof value[field] !== 'string' || value[field].length > 512 || !/^https:\/\//.test(value[field]))) fail('branding is invalid');
  }
  if (!value.colors || typeof value.colors !== 'object' || Array.isArray(value.colors) || Object.keys(value.colors).some((key) => !['background', 'surface', 'accent', 'text'].includes(key))) fail('branding is invalid');
  for (const field of ['background', 'surface', 'accent', 'text']) if (!/^#[0-9a-fA-F]{6}$/.test(value.colors[field] || '')) fail('branding is invalid');
  return { ...value, productName: value.productName.trim(), shortName: value.shortName.trim() };
}

function validateDocument(key, value) {
  if (key === ROLE_MAP_KEY) return roleMap(value);
  if (key === GRANTS_KEY) return grants(value);
  if (key === VENDORS_KEY) return vendors(value);
  if (key === PRINCIPALS_KEY) return principals(value);
  if (key === BRANDING_KEY) return branding(value);
  fail('policy document is invalid');
}

class PolicyStore {
  constructor({ endpoint, storageAccount, tableName = 'brokerPolicy', credential = new DefaultAzureCredential(), client } = {}) {
    if (client) {
      this.mode = endpoint ? 'appconfig' : 'table';
      this.client = client;
    } else if (storageAccount) {
      if (!/^[a-z0-9]{3,24}$/.test(storageAccount)) throw new TypeError('policy storage account is invalid');
      this.mode = 'table';
      this.client = new TableClient(`https://${storageAccount}.table.core.windows.net`, tableName, credential);
    } else if (typeof endpoint === 'string' && /^https:\/\//.test(endpoint)) {
      this.mode = 'appconfig';
      this.client = new AppConfigurationClient(endpoint, credential);
    } else {
      throw new TypeError('policy storage is required');
    }
  }

  async get(key) {
    if (this.mode === 'appconfig') {
      const setting = await this.client.getConfigurationSetting({ key }).catch((error) => error.statusCode === 404 ? null : Promise.reject(error));
      return setting ? { value: validateDocument(key, json(setting.value, key)), etag: setting.etag } : { value: DEFAULTS[key], etag: undefined };
    }
    const entity = await this.client.getEntity('policy', key).catch((error) => error.statusCode === 404 ? null : Promise.reject(error));
    return entity ? { value: validateDocument(key, json(entity.document, key)), etag: entity.etag } : { value: DEFAULTS[key], etag: undefined };
  }

  async set(key, document, etag) {
    validateDocument(key, document);
    const value = JSON.stringify(document);
    if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail('policy document is invalid');
    if (this.mode === 'appconfig') return this.client.setConfigurationSetting({ key, value, contentType: CONTENT_TYPE, ...(etag ? { onlyIfUnchanged: true, etag } : {}) });
    const entity = { partitionKey: 'policy', rowKey: key, schemaVersion: document.schemaVersion || 1, document: value, updatedAt: new Date().toISOString() };
    if (etag) return this.client.updateEntity(entity, 'Replace', { etag });
    try { return await this.client.createEntity(entity); } catch (error) {
      if (error.statusCode !== 409) throw error;
      const conflict = new Error('policy changed; reload and retry'); conflict.status = 409; throw conflict;
    }
  }

  async read() {
    const [roleMapSetting, grantSetting, vendorSetting, principalSetting, brandingSetting] = await Promise.all([
      this.get(ROLE_MAP_KEY), this.get(GRANTS_KEY), this.get(VENDORS_KEY), this.get(PRINCIPALS_KEY), this.get(BRANDING_KEY),
    ]);
    return Object.freeze({
      roleMap: roleMapSetting.value,
      grants: grantSetting.value,
      vendors: vendorSetting.value,
      principals: principalSetting.value,
      branding: brandingSetting.value,
      etags: Object.freeze({ roleMap: roleMapSetting.etag, grants: grantSetting.etag, vendors: vendorSetting.etag, principals: principalSetting.etag, branding: brandingSetting.etag }),
    });
  }

  async writeGrants(document, etag) {
    return this.set(GRANTS_KEY, document, etag);
  }

  async writeRoleMap(document, etag) {
    return this.set(ROLE_MAP_KEY, document, etag);
  }

  async writeVendors(document, etag) {
    return this.set(VENDORS_KEY, document, etag);
  }
  async writePrincipals(document, etag) {
    return this.set(PRINCIPALS_KEY, document, etag);
  }
  async writeBranding(document, etag) {
    return this.set(BRANDING_KEY, document, etag);
  }
}

function connectionIdForRole(role, entry) {
  if (entry && typeof entry === 'object' && typeof entry.connectionId === 'string' && entry.connectionId) return entry.connectionId;
  const part = String(role).split('.').find((value) => value && !/^(vendorapi|invoke)$/i.test(value));
  return `azure:${String(part || role).toLowerCase()}`;
}
function vendorIdFor(value) { return String(value || 'unassigned').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'unassigned'; }

function publicConnections(map) {
  return Object.entries(map).map(([role, entry]) => ({
    id: connectionIdForRole(role, entry),
    role,
    // Key Vault secret names are the authoritative operator-facing labels. Entra role values
    // remain available for diagnostics, but are never used as the default display name.
    displayName: (entry && typeof entry === 'object' && typeof entry.displayName === 'string') ? entry.displayName : (typeof entry === 'string' ? entry : entry.secret),
    vendor: (entry && typeof entry === 'object' && typeof entry.vendor === 'string') ? entry.vendor : (typeof entry === 'string' ? entry : entry.secret),
    vendorId: vendorIdFor((entry && typeof entry === 'object' && typeof entry.vendor === 'string') ? entry.vendor : (typeof entry === 'string' ? entry : entry.secret)),
    provider: 'Azure Key Vault',
    status: entry && typeof entry === 'object' && entry.enabled === false ? 'disabled' : 'active',
    enabled: !(entry && typeof entry === 'object' && entry.enabled === false),
    lastRotatedAt: entry && typeof entry === 'object' && typeof entry.lastRotatedAt === 'string' ? entry.lastRotatedAt : null,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function updateConnectionStatus(map, connectionId, enabled) {
  if (typeof enabled !== 'boolean') fail('connection status is invalid');
  const copy = JSON.parse(JSON.stringify(map));
  const found = Object.entries(copy).find(([role, entry]) => connectionIdForRole(role, entry) === connectionId);
  if (!found) fail('connection is not found');
  const [role, entry] = found;
  copy[role] = typeof entry === 'string' ? { secret: entry, enabled } : { ...entry, enabled };
  return copy;
}

function recordRotation(map, connectionId, rotatedAt) {
  if (typeof rotatedAt !== 'string' || Number.isNaN(Date.parse(rotatedAt))) fail('rotation metadata is invalid');
  const copy = JSON.parse(JSON.stringify(map));
  const found = Object.entries(copy).find(([role, entry]) => connectionIdForRole(role, entry) === connectionId);
  if (!found) fail('connection is not found');
  const [role, entry] = found;
  copy[role] = typeof entry === 'string' ? { secret: entry, lastRotatedAt: rotatedAt } : { ...entry, lastRotatedAt: rotatedAt };
  return copy;
}

function mutateGrant(document, connectionId, kind, subject, remove = false) {
  if (!['user', 'group', 'workload'].includes(kind) || typeof subject !== 'string' || !subject.startsWith(`${kind}:`) || subject.length > 256) fail('grant is invalid');
  const field = kind === 'user' ? 'subjects' : kind === 'group' ? 'groups' : 'workloads';
  const copy = JSON.parse(JSON.stringify(document));
  let connection = copy.connections.find((item) => item.id === connectionId);
  if (!connection && !remove) { connection = { id: connectionId, [field]: [] }; copy.connections.push(connection); }
  if (!connection) return copy;
  const values = Array.isArray(connection[field]) ? connection[field] : [];
  const next = remove ? values.filter((item) => item !== subject) : [...new Set([...values, subject])];
  if (next.length) connection[field] = next;
  else delete connection[field];
  if (!connection.subjects && !connection.groups && !connection.workloads) copy.connections = copy.connections.filter((item) => item !== connection);
  return copy;
}

module.exports = { PolicyStore, ROLE_MAP_KEY, GRANTS_KEY, VENDORS_KEY, PRINCIPALS_KEY, BRANDING_KEY, publicConnections, mutateGrant, connectionIdForRole, vendorIdFor, updateConnectionStatus, recordRotation, branding };
