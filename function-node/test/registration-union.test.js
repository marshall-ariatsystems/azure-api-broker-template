'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  inspectRegistrationPackage,
  parseRegistrationPackage,
  signRegistrationPackage,
  verifyRegistrationPackage,
} = require('../src/registration-packages');
const {
  LEGACY_DOCUMENT,
  LOGICAL_PACKAGE,
  PEM_PREFIX,
  signedAuthoritative,
  UNION_SECRET_SAMPLES,
} = require('./registration-union-fixtures');

test('authoritative package round-trips', () => {
  const { document, raw } = signedAuthoritative();
  assert.deepEqual(parseRegistrationPackage(raw), document);
  assert.deepEqual(verifyRegistrationPackage(raw, { trustedPublicKeySpki: document.signature.publicKeySpki }), document);
  const inspected = inspectRegistrationPackage(raw);
  assert.equal(inspected.signatureState, 'valid');
  assert.equal(inspected.lines.length, 8);
});

test('union secret corpus rejected', () => {
  const samples = [...UNION_SECRET_SAMPLES, ['displayName', PEM_PREFIX]];
  for (const [field, value] of samples) {
    const candidate = structuredClone(LOGICAL_PACKAGE);
    candidate[field] = field === 'bootstrap' ? [value] : value;
    assert.throws(
      () => signRegistrationPackage(candidate, crypto.generateKeyPairSync('ed25519').privateKey),
      (error) => error.message.startsWith('registration package validation failed: ') && !error.message.includes(value),
    );
  }
});

test('legacy wire format cannot revive', () => {
  assert.throws(() => parseRegistrationPackage(JSON.stringify(LEGACY_DOCUMENT)));
});
