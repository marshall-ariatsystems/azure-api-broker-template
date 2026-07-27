'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { validateOidcAccessToken } = require('../src/oidc-identity-adapter');
const { AUDIENCE, DISCOVERY_OK, ISSUER, JWKS, NOW_MS, makeFetcher, signAccessToken } = require('./oidc-parity-fixtures');

test('unverifiable algorithm not advertised', async () => {
  const originalNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    const bad = signAccessToken({}, { alg: 'ES256', kid: 'kid-oidc-parity-0001', typ: 'JWT' });
    const badFetcher = makeFetcher(DISCOVERY_OK, JWKS);
    await assert.rejects(validateOidcAccessToken({ token: bad, config: { issuer: ISSUER, audience: AUDIENCE }, fetchImpl: badFetcher.fetcher }));
    const validFetcher = makeFetcher(DISCOVERY_OK, JWKS);
    const identity = await validateOidcAccessToken({ token: signAccessToken(), config: { issuer: ISSUER, audience: AUDIENCE }, fetchImpl: validFetcher.fetcher });
    assert.equal(identity.oid, 'subject-parity');
  } finally { Date.now = originalNow; }
  for (const file of ['../src/generic-oidc-validation.js', '../src/oidc-identity-adapter.js']) assert.doesNotMatch(fs.readFileSync(require.resolve(file), 'utf8'), /ES256/);
});
