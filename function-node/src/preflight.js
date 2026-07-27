'use strict';

// preflight.js — deterministic, credential-free authorization preflight.

const { parseConnectionGrants, authorizeGrant } = require('./connection-grants');
const { slugForRole, connectionIdForRole } = require('./role-routing');

const CORRELATION_PATTERN = Object.freeze(/^[A-Za-z0-9._-]{8,128}$/);
const RESPONSE_FIELDS = Object.freeze(['status', 'correlationId', 'subjectType', 'route', 'authorization']);
const AUTHORIZATION_VALUES = Object.freeze(['allowed', 'role-denied', 'route-denied', 'grant-denied']);

function frozenResult(result) {
  return Object.freeze(result);
}

function correlationId(callerCorrelationId, idSource) {
  if (typeof callerCorrelationId === 'string' && CORRELATION_PATTERN.test(callerCorrelationId)) return callerCorrelationId;
  if (!idSource || typeof idSource.next !== 'function') throw new TypeError('a correlation id source is required');
  const generated = idSource.next();
  if (typeof generated !== 'string' || !CORRELATION_PATTERN.test(generated)) throw new TypeError('correlation id source returned an invalid id');
  return generated;
}

function assertCounters(counters) {
  if (!counters || typeof counters !== 'object' ||
    !['kv', 'vendor', 'oauth', 'fetch'].every((key) => Object.prototype.hasOwnProperty.call(counters, key))) {
    throw new TypeError('side-effect counters are required');
  }
}

function principalShape(principal) {
  const value = principal && typeof principal === 'object' ? principal : {};
  if (typeof value.oid === 'string' && value.oid) return Object.freeze({
    subjectType: 'user', subject: `user:${value.oid}`,
    ...(Array.isArray(value.groups) && value.groups.length ? { groups: value.groups } : {}),
  });
  if (typeof value.azp === 'string' && value.azp) return Object.freeze({ subjectType: 'workload', subject: `workload:${value.azp}`, workload: `workload:${value.azp}` });
  return undefined;
}

function runPreflight({ principal, routeSlug, roleSecretMap, connectionGrantsJson, callerCorrelationId, idSource, counters } = {}) {
  assertCounters(counters);
  const id = correlationId(callerCorrelationId, idSource);
  const identity = principalShape(principal);
  if (!identity) return frozenResult({ status: 401, correlationId: id });

  const roles = Array.isArray(principal.roles) ? principal.roles : [];
  const map = roleSecretMap && typeof roleSecretMap === 'object' ? roleSecretMap : {};
  const selected = Object.entries(map).find(([role, entry]) => slugForRole(role, entry) === routeSlug);
  if (!selected) return frozenResult({ status: 403, correlationId: id, subjectType: identity.subjectType, authorization: 'route-denied' });

  const [role, entry] = selected;
  if (!roles.includes(role)) return frozenResult({ status: 403, correlationId: id, subjectType: identity.subjectType, authorization: 'role-denied' });

  const connectionId = connectionIdForRole(role, entry);
  const grants = parseConnectionGrants(connectionGrantsJson, { knownConnectionIds: Object.freeze([connectionId]) });
  const grant = authorizeGrant({
    identity: identity.workload ? { subject: identity.subject, workload: identity.workload } : {
      subject: identity.subject,
      ...(identity.groups ? { groups: identity.groups } : {}),
    },
    connection: { id: connectionId },
    grants,
  });
  if (!grant.allowed) return frozenResult({ status: 403, correlationId: id, subjectType: identity.subjectType, authorization: 'grant-denied' });

  return frozenResult({ status: 200, correlationId: id, subjectType: identity.subjectType, route: routeSlug, authorization: 'allowed' });
}

function safeLogLine(result) {
  const value = result && typeof result === 'object' ? result : {};
  return `preflight status=${value.status} subjectType=${value.subjectType || 'none'} route=${value.route || 'none'} authorization=${value.authorization || 'none'} correlationId=${value.correlationId}`;
}

module.exports = Object.freeze({ CORRELATION_PATTERN, RESPONSE_FIELDS, AUTHORIZATION_VALUES, runPreflight, safeLogLine });
