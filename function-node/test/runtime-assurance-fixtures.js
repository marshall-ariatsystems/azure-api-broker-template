'use strict';
// Frozen runtime-assurance fixtures — deterministic, in-process, no network/Azure/hardware.
const T0 = Date.parse('2026-07-26T00:00:00Z'); // 1785024000000

const assurancePolicy = Object.freeze({
  requiredAcr: 'urn:assurance:fido2', requiredAmr: 'hwk',
});
const hardwareKeyEvidence = Object.freeze({
  iss: 'https://issuer.test', sub: 'alice', aud: 'broker-audience',
  iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600,
  jti: 'jti-hardware-0001', acr: 'urn:assurance:fido2',
  amr: Object.freeze(['hwk', 'user']), groups: Object.freeze(['group:ops']),
});
const lowerAssuranceEvidence = Object.freeze({
  iss: 'https://issuer.test', sub: 'alice', aud: 'broker-audience',
  iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 3600,
  jti: 'jti-password-0001', acr: 'urn:assurance:mfa',
  amr: Object.freeze(['pwd', 'otp']), groups: Object.freeze(['group:ops']),
});
const connection = Object.freeze({
  id: 'azure:orders', provider: 'azure-reference',
  baseUrl: 'https://vendor.test', injection: 'header',
});
const grants = Object.freeze({ version: 1, connections: Object.freeze([
  Object.freeze({ id: 'azure:orders', subjects: Object.freeze(['user:alice']),
    groups: Object.freeze(['group:ops']) }),
]) });
const knownConnectionIds = Object.freeze(['azure:orders']);
const rateLimitPolicy = Object.freeze({ identityPerMinute: 3, connectionPerMinute: 5 });
function createTestClock(startMs = T0) {
  let nowMs = startMs;
  return Object.freeze({ now: () => nowMs, advance(ms) { nowMs += ms; } });
}
const ROTATION_GRACE_MS = 5 * 60 * 1000; // mirrors broker.js:155 SECRET_TTL_MS
const staticKeyRing = Object.freeze([
  Object.freeze({ keyId: 'key-2026-06', secret: 'DISTINCTIVE-OLD-STATIC-KEY', retiredAtMs: T0 }),
  Object.freeze({ keyId: 'key-2026-07', secret: 'DISTINCTIVE-NEW-STATIC-KEY', activatedAtMs: T0 }),
]);
const AUDIT_FIELDS = Object.freeze([
  'at', 'action', 'connectionId', 'subjectKind', 'outcome', 'reason', 'retryAfterSeconds',
]);
const AUDIT_ACTIONS = Object.freeze([
  'assurance.evaluated', 'rate-limit.enforced', 'token.lifecycle', 'static-key.rotated',
]);
const AUDIT_OUTCOMES = Object.freeze(['allowed', 'denied', 'recovered', 'rotated']);
const AUDIT_REASONS = Object.freeze([
  'assurance-sufficient', 'assurance-insufficient',
  'identity-quota-exhausted', 'connection-quota-exhausted',
  'evidence-expired', 'evidence-replayed', 'token-refreshed', 'remint-limit-reached',
  'key-active', 'key-grace', 'key-retired',
]);
const SUBJECT_KINDS = Object.freeze(['user', 'group', 'workload']);
module.exports = Object.freeze({
  T0, assurancePolicy, hardwareKeyEvidence, lowerAssuranceEvidence,
  connection, grants, knownConnectionIds, rateLimitPolicy, createTestClock,
  ROTATION_GRACE_MS, staticKeyRing,
  AUDIT_FIELDS, AUDIT_ACTIONS, AUDIT_OUTCOMES, AUDIT_REASONS, SUBJECT_KINDS,
});
