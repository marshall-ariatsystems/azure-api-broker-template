'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { discover, verifyAccessToken } = require('../src/generic-oidc-validation');
const { validateOidcAccessToken } = require('../src/oidc-identity-adapter');
const { AUDIENCE, DISCOVERY_HTTP_TOKEN, DISCOVERY_OK, FUTURE_IAT_OFFSET_SEC, ISSUER, JWKS, JWKS_URI, NOW_MS, makeFetcher, signAccessToken, jsonResponse } = require('./oidc-parity-fixtures');

const trust = (fetcher) => ({ issuer: ISSUER, audience: AUDIENCE, jwksUri: DISCOVERY_OK.jwks_uri, fetcher });

test('issuer-scoped jwks reuse', async () => {
  const { fetcher, calls } = makeFetcher();
  await verifyAccessToken(signAccessToken(), trust(fetcher), NOW_MS);
  await verifyAccessToken(signAccessToken({ sub: 'second-subject' }), trust(fetcher), NOW_MS);
  assert.equal(calls.jwks, 1);
});

test('server generic validator parity', async () => {
  const token = signAccessToken(); const generic = makeFetcher();
  const metadata = await discover(ISSUER, generic.fetcher);
  const claims = await verifyAccessToken(token, trust(generic.fetcher), NOW_MS);
  assert.equal(metadata.token_endpoint, DISCOVERY_OK.token_endpoint);
  assert.equal(claims.sub, 'subject-parity'); assert.equal(claims.aud, AUDIENCE);
  const adapter = makeFetcher(); const originalNow = Date.now; Date.now = () => NOW_MS;
  try { const identity = await validateOidcAccessToken({ token, config: { issuer: ISSUER, audience: AUDIENCE }, fetchImpl: adapter.fetcher }); assert.equal(identity.oid, 'subject-parity'); } finally { Date.now = originalNow; }
});

test('http discovery endpoint rejected', async () => {
  const { fetcher } = makeFetcher(DISCOVERY_HTTP_TOKEN);
  await assert.rejects(discover(ISSUER, fetcher), /invalid discovery metadata/);
});

test('future iat is rejected', async () => {
  const { fetcher } = makeFetcher();
  await assert.rejects(verifyAccessToken(signAccessToken({ iat: Math.floor(NOW_MS / 1000) + FUTURE_IAT_OFFSET_SEC }), trust(fetcher), NOW_MS));
});

test('both JWKS validators honor zero, default missing, and capped cache-control TTLs', async () => {
  const cases = [
    { name: 'zero', header: 'max-age=0', secondNow: NOW_MS, expectedCalls: 2 },
    { name: 'missing', header: '', secondNow: NOW_MS + 1, expectedCalls: 1 },
    { name: 'capped', header: 'max-age=999999', secondNow: NOW_MS + 3_599_999, expectedCalls: 1 },
  ];
  for (const item of cases) {
    const jwksUri = `${JWKS_URI}?ttl=${item.name}`;
    const discovery = { ...DISCOVERY_OK, jwks_uri: jwksUri };
    let genericCalls = 0;
    const genericFetcher = async (url) => {
      if (String(url).endsWith('/.well-known/openid-configuration')) return jsonResponse(discovery);
      if (String(url) === jwksUri) { genericCalls++; return { ...jsonResponse(JWKS), headers: { get: () => item.header } }; }
      throw new Error(`unexpected ${url}`);
    };
    await verifyAccessToken(signAccessToken(), { issuer: ISSUER, audience: AUDIENCE, jwksUri, fetcher: genericFetcher }, NOW_MS);
    await verifyAccessToken(signAccessToken(), { issuer: ISSUER, audience: AUDIENCE, jwksUri, fetcher: genericFetcher }, item.secondNow);
    assert.equal(genericCalls, item.expectedCalls, `generic ${item.name}`);

    let adapterCalls = 0; let now = NOW_MS;
    const adapterFetcher = async (url) => {
      if (String(url).endsWith('/.well-known/openid-configuration')) return jsonResponse(discovery);
      if (String(url) === jwksUri) { adapterCalls++; return { ...jsonResponse(JWKS), headers: { get: () => item.header } }; }
      throw new Error(`unexpected ${url}`);
    };
    const realNow = Date.now; Date.now = () => now;
    try {
      await validateOidcAccessToken({ token: signAccessToken(), config: { issuer: ISSUER, audience: AUDIENCE }, fetchImpl: adapterFetcher });
      now = item.secondNow;
      await validateOidcAccessToken({ token: signAccessToken(), config: { issuer: ISSUER, audience: AUDIENCE }, fetchImpl: adapterFetcher });
    } finally { Date.now = realNow; }
    assert.equal(adapterCalls, item.expectedCalls, `adapter ${item.name}`);
  }
});
