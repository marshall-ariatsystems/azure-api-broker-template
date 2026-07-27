'use strict';
const crypto = require('node:crypto');
const { signRegistrationPackage } = require('../src/registration-packages');
// A minimal valid authoritative logical package (shape mirrors registration-packages.js content()).
const LOGICAL_PACKAGE = Object.freeze({
  id: 'regpkg:union-fixture',
  displayName: 'Union Fixture Connector',
  discovery: Object.freeze({ issuer: 'https://issuer.union.test' }),
  redirectUris: Object.freeze(['http://127.0.0.1:8765/callback']),
  resource: Object.freeze({ audience: 'api://union/.default' }),
  claims: Object.freeze({ roles: 'roles', groups: 'groups' }),
  assurance: Object.freeze({}),
  bootstrap: Object.freeze(['Step one']),
});
function signedAuthoritative() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const document = signRegistrationPackage(structuredClone(LOGICAL_PACKAGE), privateKey);
  return { document, raw: JSON.stringify(document) };
}
// Union secret corpus — each planted value MUST be rejected wherever it appears, incl. display fields.
// Placed on displayName (a display field) to prove there is NO display-field exemption.
const UNION_SECRET_SAMPLES = Object.freeze([
  Object.freeze(['displayName', 'scope=offline_access']),        // MISSED by current SECRET_VALUE (P2)
  Object.freeze(['displayName', 'secret=PLANTED-BARE-SECRET']),  // MISSED by current SECRET_VALUE (P2)
  Object.freeze(['displayName', 'client_secret=PLANTED-CLIENT']),// already caught
  Object.freeze(['bootstrap', 'Bearer PLANTEDBEARERabcdef1234']),// already caught (>=16)
  Object.freeze(['bootstrap', 'eyJhbGciOiJSUzI1NiJ9.PAYLOAD.']), // already caught (JWT-shaped)
]);
// A PEM sample is assembled at runtime to avoid embedding key material in the fixture literal.
const PEM_PREFIX = '-----' + 'BEGIN PRIVATE KEY-----';
// A legacy tessera-registration/v1 document that must NOT be accepted as a second valid format.
const LEGACY_DOCUMENT = Object.freeze({
  format: 'tessera-registration/v1', version: 1, signingKeyId: 'legacy-key',
  payload: Object.freeze({ issuer: 'https://issuer.union.test', clientId: 'legacy-client',
    redirectUri: 'http://127.0.0.1:8765/callback' }),
  signature: 'AAAA',
});
module.exports = Object.freeze({
  LOGICAL_PACKAGE, signedAuthoritative, UNION_SECRET_SAMPLES, PEM_PREFIX, LEGACY_DOCUMENT,
});
