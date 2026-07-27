'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseConnectionGrants, normalizeGrantIdentity, authorizeGrant } = require('../src/connection-grants');
const f = require('./identity-normalization-fixtures');
function parsed(raw) { return parseConnectionGrants(raw, { knownConnectionIds: f.KNOWN_CONNECTION_IDS }); }
function authorize(identity, grants) { return authorizeGrant({ identity, connection: f.CONNECTION, grants }); }

test('no-groups user grant succeeds', () => {
  const identity = normalizeGrantIdentity({ subject: 'user:DISTINCTIVE-SUBJECT-OID', ...f.EVIDENCE_NO_GROUPS });
  assert.deepEqual(authorize(identity, parsed(f.SUBJECT_ONLY_GRANTS)), { allowed: true, reason: 'allowed' });
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(identity)), 'groups'), false);
  assert(Object.isFrozen(identity));
});

test('empty groups grant succeeds', () => {
  const identity = normalizeGrantIdentity({ subject: 'user:DISTINCTIVE-SUBJECT-OID', ...f.EVIDENCE_EMPTY_GROUPS });
  assert.deepEqual(authorize(identity, parsed(f.SUBJECT_ONLY_GRANTS)), { allowed: true, reason: 'allowed' });
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(identity)), 'groups'), false);
  // collection assurance membership is proven in assurance-parity.test.js.
});

test('workload grant succeeds without groups', () => {
  const identity = normalizeGrantIdentity({ subject: 'workload:DISTINCTIVE-AZP', workload: 'workload:DISTINCTIVE-AZP' });
  assert.deepEqual(authorize(identity, parsed(f.WORKLOAD_ONLY_GRANTS)), { allowed: true, reason: 'allowed' });
});

test('malformed grant subjects still reject', () => {
  for (const subject of ['user:', 'user:ALICE*']) assert.throws(() => normalizeGrantIdentity({ subject }));
});
