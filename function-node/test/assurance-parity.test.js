'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateAssurance } = require('../src/assurance-policy');
const { evaluateConfiguredAssurance } = require('../src/generic-oidc-authority');
const f = require('./identity-normalization-fixtures');
function genericDecision(claims, assurance) { try { evaluateConfiguredAssurance(claims, assurance); return true; } catch (error) { assert.equal(error.message, 'required assurance is missing'); return false; } }

test('collection assurance membership', () => {
  const fixtures = [f.CLAIMS_SUFFICIENT, f.CLAIMS_WRONG_ACR, f.CLAIMS_AMR_MISSING, f.CLAIMS_AMR_PARTIAL];
  const expected = [true, false, false, false];
  for (let index = 0; index < fixtures.length; index++) {
    const claims = fixtures[index];
    // This is the same exact-equality + AMR-membership decision used by the oidc adapter.
    assert.equal(evaluateAssurance(claims, f.ASSURANCE_POLICY).sufficient, expected[index]);
    assert.equal(genericDecision(claims, { claim: 'amr', equals: 'hwk' }), claims === f.CLAIMS_SUFFICIENT || claims === f.CLAIMS_WRONG_ACR);
  }
  assert.equal(genericDecision(f.CLAIMS_SUFFICIENT, { claim: 'acr', equals: 'urn:assurance:fido2' }), true);
  for (const claims of [f.CLAIMS_WRONG_ACR, f.CLAIMS_AMR_MISSING, f.CLAIMS_AMR_PARTIAL]) assert.equal(genericDecision(claims, { claim: 'acr', equals: 'urn:assurance:fido2' }), claims !== f.CLAIMS_WRONG_ACR);
  assert.equal(genericDecision({ amr: 'hwk' }, { claim: 'amr', equals: 'hwk' }), true);
});
