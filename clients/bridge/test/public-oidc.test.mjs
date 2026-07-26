import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { verifyAccessToken, verifyIdToken } from '../oidc-validation.mjs';
import { login } from '../public-oidc.mjs';
import { clearSession, getAccessToken } from '../session.mjs';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://issuer.test';
const clientId = 'public-client';
const audience = 'broker';
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwks = { keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', kty: 'RSA' }] };

function signed(claims, { privateKey = pair.privateKey } = {}) {
  const header = encode({ alg: 'RS256', kid: 'test-key' });
  const body = encode(claims);
  const signature = createSign('RSA-SHA256').update(`${header}.${body}`).end().sign(privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('signed token validates exact issuer and audience', async () => {
  const now = Date.now();
  const token = signed({ iss: issuer, aud: audience, sub: 'alice', exp: Math.floor(now / 1000) + 60 });
  const claims = await verifyAccessToken(token, { issuer, audience, jwks }, now);
  assert.equal(claims.sub, 'alice');
});

test('nonce-bound ID token rejects missing, wrong, replayed, invalid-signature, and wrong-audience proofs', async () => {
  const now = Date.now();
  const base = { iss: issuer, aud: clientId, sub: 'alice', exp: Math.floor(now / 1000) + 60 };
  const trust = { issuer, audience: clientId, jwks };
  await assert.rejects(verifyIdToken(signed(base), trust, 'pending-nonce', now), /invalid nonce/);
  await assert.rejects(verifyIdToken(signed({ ...base, nonce: 'wrong' }), trust, 'pending-nonce', now), /invalid nonce/);
  await assert.rejects(verifyIdToken(signed({ ...base, nonce: 'used-nonce' }), trust, 'pending-nonce', now), /invalid nonce/);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verifyIdToken(signed({ ...base, nonce: 'pending-nonce' }, { privateKey: other.privateKey }), trust, 'pending-nonce', now), /invalid signature/);
  await assert.rejects(verifyIdToken(signed({ ...base, aud: 'other-client', nonce: 'pending-nonce' }), trust, 'pending-nonce', now), /invalid audience/);
});

test('login and run stores only a nonce-bound signed access token in RAM', async () => {
  clearSession();
  const now = Date.now();
  let authorizationUrl;
  let tokenRequest;
  const fetcher = async (url, options = {}) => {
    const value = String(url);
    if (value === `${issuer}/.well-known/openid-configuration`) {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (value === `${issuer}/jwks`) return json(jwks);
    if (value === `${issuer}/token`) {
      tokenRequest = options;
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('code'), 'authorization-code');
      assert.match(form.get('code_verifier'), /^[A-Za-z0-9_-]{32,}$/);
      assert.equal(form.has('client_secret'), false);
      const authorization = new URL(authorizationUrl);
      const idToken = signed({ iss: issuer, aud: clientId, sub: 'alice', nonce: authorization.searchParams.get('nonce'), exp: Math.floor(now / 1000) + 60 });
      const accessToken = signed({ iss: issuer, aud: audience, sub: 'alice', exp: Math.floor(now / 1000) + 60 });
      return json({ id_token: idToken, access_token: accessToken, refresh_token: 'must-not-be-retained' });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  await login({ issuer, clientId, audience }, {
    fetcher,
    now: () => now,
    present(value) {
      authorizationUrl = value;
      const authorization = new URL(value);
      assert.equal(authorization.searchParams.get('response_type'), 'code');
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.match(authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(authorization.searchParams.has('client_secret'), false);
      queueMicrotask(async () => {
        const redirect = new URL(authorization.searchParams.get('redirect_uri'));
        redirect.searchParams.set('state', authorization.searchParams.get('state'));
        redirect.searchParams.set('code', 'authorization-code');
        await fetch(redirect);
      });
    },
  });
  assert.equal(tokenRequest.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.match(getAccessToken(now), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  clearSession();
  assert.equal(getAccessToken(now), undefined);
});
