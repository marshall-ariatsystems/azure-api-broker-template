import assert from 'node:assert/strict';
import test from 'node:test';

import { brokerRequestHeaders, isBlockedRequestHeader } from '../request-policy.mjs';

const CREDENTIAL_HEADER_FIXTURES = [
  'authorization', 'x-api-key', 'api-key', 'apikey', 'api_key', 'subscription-key',
  'access_token', 'token', 'client_id', 'client_secret', 'x-api-secret', 'x-key-id',
  'x-secret', 'key', 'x-api-key-id',
];
const HOP_BY_HOP_HEADER_FIXTURES = [
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length',
  'proxy-authorization', 'proxy-authenticate',
];
const PROXY_HEADER_FIXTURES = ['proxy-authorization', 'proxy-authenticate'];
const CASE_VARIANTS = ['Authorization', 'AUTHORIZATION', 'Proxy-Authorization', 'PROXY-AUTHENTICATE', 'X-Api-Key'];
const BENIGN_HEADER_FIXTURES = ['accept', 'content-type', 'user-agent', 'traceparent', 'x-request-id'];

test('case-insensitive parity', () => {
  for (const name of [...CREDENTIAL_HEADER_FIXTURES, ...HOP_BY_HOP_HEADER_FIXTURES, ...PROXY_HEADER_FIXTURES, ...CASE_VARIANTS]) {
    assert.equal(isBlockedRequestHeader(name), true, name);
  }
  for (const name of BENIGN_HEADER_FIXTURES) assert.equal(isBlockedRequestHeader(name), false, name);
});

test('brokerRequestHeaders forwards only bridge authentication and benign headers', () => {
  const headers = brokerRequestHeaders({
    authorization: 'caller-credential',
    'x-api-key': 'caller-credential',
    'proxy-authorization': 'caller-credential',
    'proxy-authenticate': 'caller-credential',
    accept: 'application/json',
  }, 'bridge-broker-token');
  assert.deepEqual(headers, {
    authorization: 'Bearer bridge-broker-token',
    accept: 'application/json',
  });
  assert.equal(Object.values(headers).some((value) => value === 'caller-credential'), false);
});
