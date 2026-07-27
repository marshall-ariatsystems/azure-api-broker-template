import assert from 'node:assert/strict';
import test from 'node:test';
import { createNinjaClient } from '../ninja-client.mjs';

const config = { base: 'https://broker.example.test/api/broker', scope: 'api://broker/.default' };

function response(status, headers = {}, body = '{"ok":true}') {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('public Node client validates auth headers, retries only reads, and reaches preflight', async () => {
  const calls = [];
  const client = createNinjaClient({
    config,
    acquireToken: async () => 'broker-token',
    clock: { sleep: async () => {} },
    jitter: { next: () => 0 },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/preflight/ninjaone')) return response(200, { 'x-correlation-id': 'req-preflight' });
      return calls.filter((call) => call.url.endsWith('/v2/organizations')).length === 1
        ? response(429, { 'retry-after': '0', 'x-correlation-id': 'req-rate' })
        : response(200);
    },
  });

  assert.deepEqual(await client.preflight('ninjaone'), { status: 200, correlationId: 'req-preflight' });
  assert.deepEqual(await client.ninja('/v2/organizations'), { ok: true });
  assert.equal(calls.filter((call) => call.url.endsWith('/v2/organizations')).length, 2);
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer broker-token');
  await assert.rejects(client.ninja('/v2/organizations', { headers: { Authorization: 'attacker' } }), /credential-shaped/);
  await assert.rejects(client.ninja('/v2/organizations', { headers: { 'x-api-key': 'attacker' } }), /credential-shaped/);
  await assert.rejects(client.ninja('/v2/organizations', { headers: { 'Proxy-Authorization': 'attacker' } }), /credential-shaped/);
});

test('public Node client never retries a write by default', async () => {
  let calls = 0;
  const client = createNinjaClient({
    config,
    acquireToken: async () => 'broker-token',
    clock: { sleep: async () => { throw new Error('must not sleep'); } },
    jitter: { next: () => 0 },
    fetchImpl: async () => { calls += 1; return response(429, { 'retry-after': '0' }); },
  });
  await assert.rejects(client.ninja('/v2/webhook', { method: 'POST', json: { safe: true } }), /broker 429/);
  assert.equal(calls, 1);
});
