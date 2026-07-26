// connection-grants.js — bounded, credential-free connection access grants.

const OWN = Object.prototype.hasOwnProperty;
const { requireObject, rejectUnknownKeys } = require('./schema-utils');
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 128;
const MAX_LIST_ENTRIES = 256;
const MAX_STRING_LENGTH = 256;
const GRANT_KEYS = new Set(['version', 'connections']);
const ENTRY_KEYS = new Set(['id', 'subjects', 'groups', 'workloads']);
const IDENTITY_KEYS = new Set(['subject', 'groups', 'workload']);
const CONNECTION_KEYS = new Set(['id', 'provider', 'baseUrl', 'injection']);

function fail(message) { throw new TypeError(message); }
function object(value, message) {
  return requireObject(value, () => fail(message));
}
function exactKeys(value, allowed, message) {
  rejectUnknownKeys(value, allowed, () => fail(message));
}
function string(value, prefix, message) {
  if (typeof value !== 'string' || !value || value.length > MAX_STRING_LENGTH || !value.startsWith(prefix) || value.includes('*')) fail(message);
  return value;
}
function grantList(value, prefix, name) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ENTRIES) fail(`${name} must be a nonempty bounded array`);
  const seen = new Set();
  const values = value.map((item) => string(item, prefix, `${name} contains an invalid value`));
  for (const item of values) {
    if (seen.has(item)) fail(`${name} contains a duplicate value`);
    seen.add(item);
  }
  return Object.freeze(values);
}

function parseConnectionGrants(raw, { knownConnectionIds } = {}) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_DOCUMENT_BYTES) fail('connection grants must be a bounded JSON string');
  if (!Array.isArray(knownConnectionIds) || !Object.isFrozen(knownConnectionIds)) fail('knownConnectionIds must be a frozen public ID allow-list');
  const known = new Set(knownConnectionIds);
  if (known.size !== knownConnectionIds.length || [...known].some((id) => typeof id !== 'string' || !id)) fail('knownConnectionIds is invalid');
  let document;
  try { document = JSON.parse(raw); } catch { fail('connection grants JSON is invalid'); }
  object(document, 'connection grants must be an object');
  exactKeys(document, GRANT_KEYS, 'connection grants contain an unknown field');
  if (document.version !== 1 || !Array.isArray(document.connections) || document.connections.length > MAX_CONNECTIONS) fail('connection grants schema is invalid');
  const ids = new Set();
  const connections = document.connections.map((entry) => {
    object(entry, 'connection grant entry must be an object');
    exactKeys(entry, ENTRY_KEYS, 'connection grant entry contains an unknown field');
    const id = typeof entry.id === 'string' && entry.id && entry.id.length <= MAX_STRING_LENGTH ? entry.id : fail('connection grant id is invalid');
    if (!known.has(id) || ids.has(id)) fail('connection grant id is unknown or duplicate');
    ids.add(id);
    const grant = { id };
    let count = 0;
    for (const [key, prefix] of [['subjects', 'user:'], ['groups', 'group:'], ['workloads', 'workload:']]) {
      if (OWN.call(entry, key)) { grant[key] = grantList(entry[key], prefix, key); count++; }
    }
    if (!count) fail('connection grant entry has no grants');
    return Object.freeze(grant);
  });
  return Object.freeze({ version: 1, connections: Object.freeze(connections) });
}

function normalizeGrantIdentity(input) {
  object(input, 'grant identity must be an object');
  exactKeys(input, IDENTITY_KEYS, 'grant identity contains an unknown field');
  const subject = string(input.subject, input.subject && input.subject.startsWith('workload:') ? 'workload:' : 'user:', 'grant subject is invalid');
  const result = { subject };
  if (OWN.call(input, 'groups')) result.groups = grantList(input.groups, 'group:', 'groups');
  if (OWN.call(input, 'workload')) result.workload = string(input.workload, 'workload:', 'workload is invalid');
  return Object.freeze(result);
}

function authorizeGrant(input = {}) {
  object(input, 'grant authorization input must be an object');
  exactKeys(input, new Set(['identity', 'connection', 'grants']), 'grant authorization input contains an unknown field');
  const identity = normalizeGrantIdentity(input.identity);
  object(input.connection, 'connection is invalid');
  exactKeys(input.connection, CONNECTION_KEYS, 'connection contains an unknown field');
  if (typeof input.connection.id !== 'string' || !input.connection.id) fail('connection is invalid');
  object(input.grants, 'grants are invalid');
  if (input.grants.version !== 1 || !Array.isArray(input.grants.connections)) fail('grants are invalid');
  const entry = input.grants.connections.find((candidate) => candidate && candidate.id === input.connection.id);
  const allowed = Boolean(entry && ((entry.subjects || []).includes(identity.subject) ||
    (identity.groups || []).some((group) => (entry.groups || []).includes(group)) ||
    (identity.workload && (entry.workloads || []).includes(identity.workload))));
  return Object.freeze({ allowed, reason: allowed ? 'allowed' : 'denied' });
}

module.exports = { parseConnectionGrants, normalizeGrantIdentity, authorizeGrant };
