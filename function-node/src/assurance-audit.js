'use strict';

const FIELDS = Object.freeze(['at', 'action', 'connectionId', 'subjectKind', 'outcome', 'reason', 'retryAfterSeconds']);
const ACTIONS = new Set(['assurance.evaluated', 'rate-limit.enforced', 'token.lifecycle', 'static-key.rotated']);
const OUTCOMES = new Set(['allowed', 'denied', 'recovered', 'rotated']);
const REASONS = new Set(['assurance-sufficient', 'assurance-insufficient', 'identity-quota-exhausted', 'connection-quota-exhausted', 'evidence-expired', 'evidence-replayed', 'token-refreshed', 'remint-limit-reached', 'key-active', 'key-grace', 'key-retired']);
const SUBJECT_KINDS = new Set(['user', 'group', 'workload']);
function rejected() { throw new TypeError('audit record rejected'); }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function createAssuranceAudit(sink) {
  if (typeof sink !== 'function') rejected();
  function record(event) {
    if (!plainObject(event) || Object.keys(event).some((key) => !FIELDS.includes(key)) || !Object.hasOwn(event, 'at') || !Object.hasOwn(event, 'action') || !Object.hasOwn(event, 'outcome')) rejected();
    if (!Number.isFinite(event.at) || !Number.isInteger(event.at) || !ACTIONS.has(event.action) || !OUTCOMES.has(event.outcome)) rejected();
    if (Object.hasOwn(event, 'reason') && !REASONS.has(event.reason)) rejected();
    if (Object.hasOwn(event, 'subjectKind') && !SUBJECT_KINDS.has(event.subjectKind)) rejected();
    if (Object.hasOwn(event, 'connectionId') && (typeof event.connectionId !== 'string' || !event.connectionId || event.connectionId.length > 128 || /\s/.test(event.connectionId))) rejected();
    if (Object.hasOwn(event, 'retryAfterSeconds') && (!Number.isFinite(event.retryAfterSeconds) || !Number.isInteger(event.retryAfterSeconds) || event.retryAfterSeconds < 0)) rejected();
    const accepted = Object.freeze({ ...event }); sink(accepted); return accepted;
  }
  return Object.freeze({ record });
}
module.exports = { createAssuranceAudit };
