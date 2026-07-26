const assert = require('node:assert/strict'); const test = require('node:test'); const crypto = require('node:crypto');
const authority = require('../src/generic-oidc-authority');
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://issuer.example'; const audience = 'broker';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signed = (claims) => { const header = encode({ alg: 'RS256', kid: 'key-1' }); const body = encode(claims); const sign = crypto.createSign('RSA-SHA256'); sign.update(`${header}.${body}`); sign.end(); return `${header}.${body}.${sign.sign(pair.privateKey).toString('base64url')}`; };
const jwks = { keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'key-1', kty: 'RSA' }] };
const response = (value) => new Response(JSON.stringify(value), { status: 200 });
function fetcher(url) { if (String(url) === `${issuer}/.well-known/openid-configuration`) return response({ issuer, jwks_uri: `${issuer}/jwks` }); if (String(url) === `${issuer}/jwks`) return response(jwks); throw new Error(`unexpected ${url}`); }
test('generic OIDC rejects spoofed platform principal before downstream work', async () => {
  await assert.rejects(authority.validateRequest({ headers: new Map([['x-ms-client-principal', 'spoofed']]) }, { environment: {} }));
});

test('generic OIDC validates signed bearer, mapped claims, and configured assurance before hosted grants', async () => {
  const now = Date.now();
  const token = signed({ iss: issuer, aud: audience, sub: 'alice', exp: Math.floor(now / 1000) + 60, roles: ['VendorApi.Test.Invoke'], groups: ['group:ops'], acr: 'fido2' });
  const identity = await authority.validateRequest({ headers: new Map([['authorization', `Bearer ${token}`]]) }, { environment: { GENERIC_OIDC_ISSUER: issuer, GENERIC_OIDC_AUDIENCE: audience, GENERIC_OIDC_CLAIM_MAP: '{"roles":"roles","groups":"groups"}', GENERIC_OIDC_ASSURANCE: '{"claim":"acr","equals":"fido2"}' }, fetcher, now });
  assert.deepEqual(identity, { oid: 'alice', azp: 'alice', roles: ['VendorApi.Test.Invoke'], groups: ['group:ops'] });
});

test('generic OIDC denies invalid assurance before any downstream work', async () => {
  const now = Date.now(); const token = signed({ iss: issuer, aud: audience, sub: 'alice', exp: Math.floor(now / 1000) + 60, acr: 'password' });
  await assert.rejects(authority.validateRequest({ headers: new Map([['authorization', `Bearer ${token}`]]) }, { environment: { GENERIC_OIDC_ISSUER: issuer, GENERIC_OIDC_AUDIENCE: audience, GENERIC_OIDC_ASSURANCE: '{"claim":"acr","equals":"fido2"}' }, fetcher, now }), /assurance/);
});
