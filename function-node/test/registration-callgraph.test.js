'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  inspectRegistrationPackage,
  renderGenericOidcSetup,
} = require('../src/registration-renderers');
const { LEGACY_DOCUMENT, signedAuthoritative } = require('./registration-union-fixtures');

test('supported entry reaches only authoritative parser', () => {
  const { raw, document } = signedAuthoritative();
  const trust = { trustedPublicKeySpki: document.signature.publicKeySpki };
  const rendered = renderGenericOidcSetup(raw, trust);
  assert.equal(rendered.kind, 'generic-oidc-setup');
  assert.equal(inspectRegistrationPackage(raw).signatureState, 'valid');
  assert.throws(() => renderGenericOidcSetup(JSON.stringify(LEGACY_DOCUMENT), trust));
  const authoritativeSource = fs.readFileSync(path.join(__dirname, '../src/registration-packages.js'), 'utf8');
  assert.equal(authoritativeSource.includes('tessera-registration/v1'), false);
});

test('published registration schema is authoritative and contains no legacy wire format', () => {
  const schemaPath = path.join(__dirname, '../../registration-packages/registration-package.schema.json');
  const schemaText = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(schemaText);
  assert.deepEqual(schema.required, ['formatVersion', 'package', 'signature']);
  assert.equal(schemaText.includes('tessera-registration/v1'), false);
  assert.equal(schemaText.includes('signingKeyId'), false);
  assert.equal(schemaText.includes('"payload"'), false);
  assert.equal(fs.existsSync(path.join(__dirname, '../../registration-packages/render.mjs')), false);
});
