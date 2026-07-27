// Proof: an OpenAI endpoint cannot be used with the dummy key.
//
// The bridge hands an app the harmless `broker-managed` placeholder in place of
// a real OpenAI key. This test proves that placeholder is inert three ways:
//
//   1. the OpenAI preset only ever emits `broker-managed`, never a real key;
//   2. the bridge strips every caller credential header, so `broker-managed`
//      is never forwarded to the vendor; and
//   3. (opt-in, live) the real OpenAI endpoint rejects `broker-managed` with
//      HTTP 401 `invalid_api_key`.
//
// Parts 1 and 2 are deterministic and offline. Part 3 makes one outbound HTTPS
// request and runs only when BROKER_LIVE_OPENAI_PROOF=1, so CI stays offline.

import assert from 'node:assert/strict';
import test from 'node:test';

import { compatibilityEnvironment } from './presets.mjs';
import { brokerRequestHeaders, isBlockedRequestHeader } from '../clients/bridge/request-policy.mjs';

const DUMMY_KEY = 'broker-managed';

test('the OpenAI preset emits only the inert placeholder, never a real key', () => {
  const env = compatibilityEnvironment({ preset: 'openai', vendor: 'openai', host: '127.0.0.1', port: 8079 });
  assert.equal(env.OPENAI_API_KEY, DUMMY_KEY);
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:8079/openai/v1');
  // A real OpenAI key is `sk-...`; the placeholder must never take that shape.
  assert.doesNotMatch(env.OPENAI_API_KEY, /^sk-/);
});

test('the bridge strips the dummy key from every credential header it could arrive in', () => {
  const brokerToken = 'broker-identity-token';
  const callerHeaders = {
    authorization: `Bearer ${DUMMY_KEY}`,
    'api-key': DUMMY_KEY,
    'x-api-key': DUMMY_KEY,
    'openai-organization': 'org-abc',
    'content-type': 'application/json',
  };

  const forwarded = brokerRequestHeaders(callerHeaders, brokerToken);

  // The only credential that survives is the broker's own identity token.
  assert.equal(forwarded.authorization, `Bearer ${brokerToken}`);
  // No forwarded header value carries the caller's dummy key.
  for (const value of Object.values(forwarded)) {
    assert.doesNotMatch(String(value), new RegExp(DUMMY_KEY));
  }
  // Non-credential headers pass through untouched.
  assert.equal(forwarded['openai-organization'], 'org-abc');
  assert.equal(forwarded['content-type'], 'application/json');
  // Every credential-bearing header name is classified as blocked.
  for (const name of ['authorization', 'api-key', 'x-api-key']) {
    assert.equal(isBlockedRequestHeader(name), true);
  }
});

test('the real OpenAI endpoint rejects the dummy key with 401 (opt-in, live)', { skip: process.env.BROKER_LIVE_OPENAI_PROOF !== '1' }, async () => {
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${DUMMY_KEY}` },
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error?.code, 'invalid_api_key');
});
