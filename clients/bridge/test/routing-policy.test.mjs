import assert from 'node:assert/strict';
import test from 'node:test';

import { brokerRequestHeaders, isBlockedRequestHeader } from '../request-policy.mjs';
import { routeBrokerPath, validateRoutingMode } from '../routing.mjs';

test('strict routing consumes only the configured local vendor slug', () => {
  assert.equal(routeBrokerPath('/openai/v1/responses', { vendor: 'openai', routingMode: 'strict' }), 'v1/responses');
  assert.throws(() => routeBrokerPath('/anthropic/v1/messages', { vendor: 'openai', routingMode: 'strict' }), /does not match configured BROKER_VENDOR/);
});

test('named routing preserves the caller slug only when selected explicitly', () => {
  assert.equal(routeBrokerPath('/anthropic/v1/messages', { vendor: 'openai', routingMode: 'named' }), 'anthropic/v1/messages');
  assert.equal(validateRoutingMode(), 'strict');
  assert.throws(() => validateRoutingMode('permissive'), /BROKER_ROUTING_MODE/);
});

test('request policy strips supplied credential and platform headers but preserves normal headers', () => {
  const headers = brokerRequestHeaders({ Authorization: 'Bearer broker-managed', 'X-API-Key': 'broker-managed', TOKEN: 'not-forwarded', 'x-ms-client-request-id': 'platform-header', 'Idempotency-Key': 'preserved', 'If-Match': '"etag"', 'content-type': 'application/json' }, 'broker-token');
  assert.deepEqual(headers, { authorization: 'Bearer broker-token', 'Idempotency-Key': 'preserved', 'If-Match': '"etag"', 'content-type': 'application/json' });
  assert.equal(isBlockedRequestHeader('Api_Key'), true);
  assert.equal(isBlockedRequestHeader('x-ms-foo'), true);
  assert.equal(isBlockedRequestHeader('x-correlation-id'), false);
});
