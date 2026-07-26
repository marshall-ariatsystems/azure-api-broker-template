'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseAssurancePolicy, evaluateAssurance, requireAssurance } = require('../src/assurance-policy');
const { assurancePolicy, hardwareKeyEvidence, lowerAssuranceEvidence } = require('./runtime-assurance-fixtures');

test('hardware-key evidence accepted', () => {
  const policy = parseAssurancePolicy(JSON.stringify(assurancePolicy));
  const result = evaluateAssurance(hardwareKeyEvidence, policy);
  assert.deepEqual(result, { sufficient: true, reason: 'assurance-sufficient' }); assert(Object.isFrozen(result));
  assert.deepEqual(requireAssurance(hardwareKeyEvidence, policy), result);
  assert(!JSON.stringify(result).match(/alice|jti-|hwk|urn:assurance:/));
});
test('lower-assurance token denied', () => {
  const result = evaluateAssurance(lowerAssuranceEvidence, assurancePolicy);
  assert.deepEqual(result, { sufficient: false, reason: 'assurance-insufficient' });
  assert.throws(() => requireAssurance(lowerAssuranceEvidence, assurancePolicy), { message: 'required assurance is missing' });
  assert(!JSON.stringify(result).match(/alice|jti-|hwk|urn:assurance:/));
});
test('assurance policy is closed and AMR is an array', () => {
  for (const raw of ['{', JSON.stringify({ ...assurancePolicy, extra: 'x' }), JSON.stringify({ requiredAcr: '', requiredAmr: 'x' }), JSON.stringify({ requiredAcr: 'x', requiredAmr: '' }), JSON.stringify({ requiredAcr: 'x'.repeat(257), requiredAmr: 'x' }), 'x'.repeat(4097)]) assert.throws(() => parseAssurancePolicy(raw), TypeError);
  assert.equal(evaluateAssurance({ ...hardwareKeyEvidence, amr: 'hwk' }, assurancePolicy).sufficient, false);
  assert.equal(evaluateAssurance({ ...hardwareKeyEvidence, acr: 'other' }, assurancePolicy).sufficient, false);
});
