'use strict';
const assert = require('node:assert/strict'); const test = require('node:test');
const { createAssuranceAudit } = require('../src/assurance-audit');
test('redacted audit record', () => {
  const captured = []; const audit = createAssuranceAudit((record) => captured.push(record));
  const event = { at: 1, action: 'assurance.evaluated', outcome: 'allowed', reason: 'assurance-sufficient', connectionId: 'azure:orders', subjectKind: 'user' };
  const accepted = audit.record(event); assert.deepEqual(accepted, event); assert(Object.isFrozen(accepted)); assert.strictEqual(captured[0], accepted);
  const bad = [{ ...event, token: 'DISTINCTIVE-INBOUND-EVIDENCE' }, { ...event, secret: 'DISTINCTIVE-INBOUND-EVIDENCE' }, { ...event, authorization: 'DISTINCTIVE-INBOUND-EVIDENCE' }, { ...event, amr: 'DISTINCTIVE-INBOUND-EVIDENCE' }, { ...event, subject: 'DISTINCTIVE-INBOUND-EVIDENCE' }, { ...event, claims: 'DISTINCTIVE-INBOUND-EVIDENCE' }, { ...event, action: 'free' }, { ...event, outcome: 'free' }, { ...event, reason: 'free' }, { ...event, connectionId: 'has space' }, { ...event, connectionId: 'x'.repeat(129) }, { ...event, at: 1.1 }, { ...event, retryAfterSeconds: -1 }];
  for (const item of bad) { let error; try { audit.record(item); } catch (caught) { error = caught; } assert(error instanceof TypeError); assert(!String(error).includes('DISTINCTIVE-INBOUND-EVIDENCE')); }
  assert.equal(JSON.stringify(captured).includes('DISTINCTIVE-INBOUND-EVIDENCE'), false);
});
