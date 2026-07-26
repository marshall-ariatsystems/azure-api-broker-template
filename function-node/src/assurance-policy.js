'use strict';

const MAX_POLICY_BYTES = 4 * 1024;
const MAX_STRING_LENGTH = 256;
const POLICY_KEYS = new Set(['requiredAcr', 'requiredAmr']);

function fail(message) { throw new TypeError(message); }
function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function parseAssurancePolicy(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BYTES) fail('assurance policy must be a bounded JSON string');
  let policy;
  try { policy = JSON.parse(raw); } catch { fail('assurance policy JSON is invalid'); }
  if (!plainObject(policy) || Object.keys(policy).length !== POLICY_KEYS.size || Object.keys(policy).some((key) => !POLICY_KEYS.has(key))) fail('assurance policy schema is invalid');
  for (const key of POLICY_KEYS) if (typeof policy[key] !== 'string' || !policy[key] || policy[key].length > MAX_STRING_LENGTH) fail('assurance policy schema is invalid');
  return Object.freeze({ requiredAcr: policy.requiredAcr, requiredAmr: policy.requiredAmr });
}

function evaluateAssurance(claims, policy) {
  if (!plainObject(claims) || !plainObject(policy) || typeof policy.requiredAcr !== 'string' || typeof policy.requiredAmr !== 'string') fail('assurance input is invalid');
  const sufficient = claims.acr === policy.requiredAcr && Array.isArray(claims.amr) && claims.amr.every((item) => typeof item === 'string') && claims.amr.includes(policy.requiredAmr);
  return Object.freeze({ sufficient, reason: sufficient ? 'assurance-sufficient' : 'assurance-insufficient' });
}

function requireAssurance(claims, policy) {
  const result = evaluateAssurance(claims, policy);
  if (!result.sufficient) throw new Error('required assurance is missing');
  return result;
}

module.exports = { parseAssurancePolicy, evaluateAssurance, requireAssurance };
