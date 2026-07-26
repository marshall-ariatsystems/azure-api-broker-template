// hosted-authority.js — provider-neutral, credential-free connection authority.

const CONNECTION_FIELDS = new Set(['id', 'provider', 'baseUrl', 'injection']);
const FORBIDDEN_CONNECTION_FIELDS = /secret|key|token|password|credential/i;

function normalizeIdentity(principal) {
  if (!principal || typeof principal !== 'object') throw new TypeError('identity principal is required');
  const oid = typeof principal.oid === 'string' && principal.oid ? principal.oid : undefined;
  const azp = typeof principal.azp === 'string' && principal.azp ? principal.azp : undefined;
  if (!oid && !azp) throw new TypeError('identity requires oid or azp');
  const roles = Array.isArray(principal.roles)
    ? principal.roles.filter((role) => typeof role === 'string')
    : [];
  const groups = Array.isArray(principal.groups) ? principal.groups.filter((group) => typeof group === 'string') : [];
  const issuer = typeof principal.issuer === 'string' && principal.issuer ? principal.issuer : undefined;
  const assurance = principal.assurance && typeof principal.assurance === 'object'
    ? Object.freeze({ ...(typeof principal.assurance.acr === 'string' ? { acr: principal.assurance.acr } : {}), ...(Array.isArray(principal.assurance.amr) ? { amr: Object.freeze(principal.assurance.amr.filter((item) => typeof item === 'string')) } : {}) }) : Object.freeze({});
  return Object.freeze({ ...(oid ? { oid } : {}), ...(azp ? { azp } : {}), roles: Object.freeze([...roles]), groups: Object.freeze([...groups]), ...(issuer ? { issuer } : {}), assurance });
}

function createConnection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('connection must be an object');
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_CONNECTION_FIELDS.test(key) || key === 'operations' || key === 'scope' || key === 'scopes') {
      throw new TypeError(`connection field not permitted: ${key}`);
    }
    if (!CONNECTION_FIELDS.has(key)) throw new TypeError(`connection field not permitted: ${key}`);
  }
  const { id, provider, baseUrl, injection } = input;
  if (![id, provider, baseUrl, injection].every((value) => typeof value === 'string' && value)) {
    throw new TypeError('connection requires id, provider, baseUrl, and injection');
  }
  return Object.freeze({ id, provider, baseUrl, injection });
}

function authorizeConnection({ identity, connection, policy } = {}) {
  if (!identity || !connection || !policy || typeof policy.allows !== 'function') {
    throw new TypeError('identity, connection, and policy.allows are required');
  }
  return Object.freeze({ allowed: policy.allows(identity, connection) === true, reason: policy.allows(identity, connection) === true ? 'allowed' : 'denied' });
}

module.exports = { normalizeIdentity, createConnection, authorizeConnection };
