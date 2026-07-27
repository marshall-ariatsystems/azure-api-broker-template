'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RESPONSE_FIELDS, runPreflight, safeLogLine } = require('../src/preflight');
const fixtures = require('./preflight-fixtures');

function input(overrides = {}) {
  return {
    principal: fixtures.AUTHORIZED_PRINCIPAL,
    routeSlug: fixtures.ROUTE_SLUG,
    roleSecretMap: fixtures.ROLE_SECRET_MAP,
    connectionGrantsJson: fixtures.GRANTS,
    idSource: fixtures.createIdSource(),
    counters: fixtures.createCounters(),
    ...overrides,
  };
}

function assertZero(counters) {
  assert.equal(counters.kv, 0);
  assert.equal(counters.vendor, 0);
  assert.equal(counters.oauth, 0);
  assert.equal(counters.fetch, 0);
}

test('authorized preflight resolves route', () => {
  const args = input();
  const result = runPreflight(args);
  assert.deepEqual(result, { status: 200, correlationId: fixtures.GENERATED_CORRELATION, subjectType: 'user', route: 'ninjaone', authorization: 'allowed' });
  assert.equal(Object.isFrozen(result), true);
  assertZero(args.counters);
});

test('denied preflight is categorical', () => {
  const roleDenied = input({ principal: fixtures.ROLE_DENIED_PRINCIPAL });
  const routeDenied = input({ routeSlug: 'missing' });
  const grantDenied = input({ principal: fixtures.WORKLOAD_PRINCIPAL, connectionGrantsJson: fixtures.GRANTS_OTHER_SUBJECT });
  for (const [args, authorization] of [[roleDenied, 'role-denied'], [routeDenied, 'route-denied'], [grantDenied, 'grant-denied']]) {
    const result = runPreflight(args);
    assert.equal(result.status, 403);
    assert.equal(result.authorization, authorization);
    assert.equal(Object.hasOwn(result, 'route'), false);
    assertZero(args.counters);
  }
});

test('correlation echoed or generated', () => {
  const allowed = runPreflight(input({ callerCorrelationId: fixtures.VALID_CORRELATION }));
  const denied = runPreflight(input({ principal: fixtures.ROLE_DENIED_PRINCIPAL, callerCorrelationId: fixtures.VALID_CORRELATION }));
  const malformed = runPreflight(input({ callerCorrelationId: fixtures.MALFORMED_CORRELATION }));
  const absent = runPreflight(input());
  for (const result of [allowed, denied]) assert.equal(result.correlationId, fixtures.VALID_CORRELATION);
  for (const result of [malformed, absent]) assert.equal(result.correlationId, fixtures.GENERATED_CORRELATION);
  assert.match(safeLogLine(allowed), new RegExp(fixtures.VALID_CORRELATION));
  assert.match(safeLogLine(malformed), new RegExp(fixtures.GENERATED_CORRELATION));
});

test('preflight has zero side effects', () => {
  const counters = fixtures.createCounters();
  for (const args of [input({ counters }), input({ counters, principal: fixtures.ROLE_DENIED_PRINCIPAL }), input({ counters, routeSlug: 'missing' }), input({ counters, principal: fixtures.WORKLOAD_PRINCIPAL, connectionGrantsJson: fixtures.GRANTS_OTHER_SUBJECT })]) runPreflight(args);
  assertZero(counters);
});

test('preflight surface is redacted', () => {
  const results = [
    runPreflight(input()),
    runPreflight(input({ principal: fixtures.ROLE_DENIED_PRINCIPAL })),
    runPreflight(input({ routeSlug: 'missing' })),
    runPreflight(input({ principal: fixtures.WORKLOAD_PRINCIPAL, connectionGrantsJson: fixtures.GRANTS_OTHER_SUBJECT })),
    runPreflight(input({ principal: { roles: [] } })),
  ];
  for (const result of results) {
    assert.deepEqual(Object.keys(result).filter((key) => !RESPONSE_FIELDS.includes(key)), []);
    const surfaces = [JSON.stringify(result), safeLogLine(result)];
    for (const marker of [...fixtures.DISTINCTIVE_MARKERS, ...fixtures.FORBIDDEN_TOPOLOGY]) {
      for (const surface of surfaces) assert.equal(surface.includes(marker), false);
    }
  }
  const unauthenticated = results.at(-1);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.correlationId, fixtures.GENERATED_CORRELATION);
  assert.equal(Object.hasOwn(unauthenticated, 'authorization'), false);
  assert.equal(Object.hasOwn(unauthenticated, 'route'), false);
  assert.equal(Object.hasOwn(unauthenticated, 'subjectType'), false);
});
