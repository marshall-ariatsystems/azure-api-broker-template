import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { createBridgeRuntime, LOGIN_REQUIRED, resolveBrokerDiscovery } from '../broker-bridge.mjs';

const discovery = 'https://discovery.example.test/bootstrap';
const brokerBase = 'https://broker.example.test/api/broker';

async function unusedPort() { const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address(); await new Promise((resolve) => server.close(resolve)); return port; }
function response(body, status = 200) { return new Response(body, { status, headers: { 'content-type': 'application/json' } }); }
function fixtureFetch({ tokenRequests = [], discoveryBody = JSON.stringify({ brokerBase }), discoveryStatus = 200 } = {}) {
  return async (url, options = {}) => {
    if (String(url) === discovery) return response(discoveryBody, discoveryStatus);
    tokenRequests.push({ url: String(url), options });
    return new Response('broker-ok', { status: 201, headers: { 'x-fixture': 'yes' } });
  };
}
async function runtimeFor(adapter, requests = []) {
  const port = await unusedPort();
  const runtime = createBridgeRuntime({ brokerDiscoveryUrl: discovery, sessionAdapter: adapter, fetchImpl: fixtureFetch({ tokenRequests: requests }), port });
  await runtime.listen();
  return { runtime, port };
}

test('broker OIDC contract rejects a non-HTTPS discovery URL', () => assert.throws(() => createBridgeRuntime({ brokerDiscoveryUrl: 'http://bad.test', sessionAdapter: {} }), /HTTPS/));
test('broker OIDC contract rejects a missing session seam', () => assert.throws(() => createBridgeRuntime({ brokerDiscoveryUrl: discovery }), /getValidatedAccessToken/));
test('broker OIDC contract rejects every non-fixed bind host', () => { for (const host of ['localhost', '::1', '0.0.0.0', '::', '192.168.1.2']) assert.throws(() => createBridgeRuntime({ brokerDiscoveryUrl: discovery, sessionAdapter: { getValidatedAccessToken() {} }, host }), /exactly/); });
test('broker OIDC contract rejects malformed discovery JSON before listen', async () => await assert.rejects(resolveBrokerDiscovery(discovery, fixtureFetch({ discoveryBody: '{' })), /JSON/));
test('broker OIDC contract rejects redirect discovery responses before listen', async () => await assert.rejects(resolveBrokerDiscovery(discovery, fixtureFetch({ discoveryStatus: 302 })), /failed/));
test('broker OIDC contract rejects oversized discovery responses before listen', async () => await assert.rejects(resolveBrokerDiscovery(discovery, fixtureFetch({ discoveryBody: JSON.stringify({ brokerBase, pad: 'x'.repeat(70_000) }) })), /64 KiB/));
test('broker OIDC contract rejects discovery base mismatch', async () => await assert.rejects(resolveBrokerDiscovery(discovery, fixtureFetch({ discoveryBody: JSON.stringify({ brokerBase, extra: true }) })), /exactly/));
test('broker OIDC contract rejects a non-HTTPS broker base', async () => await assert.rejects(resolveBrokerDiscovery(discovery, fixtureFetch({ discoveryBody: JSON.stringify({ brokerBase: 'http://broker.test' }) })), /exactly/));
test('broker OIDC contract keeps health local', async () => { const requests = []; const { runtime, port } = await runtimeFor({ async getValidatedAccessToken() { throw new Error('unused'); } }, requests); try { assert.equal((await fetch(`http://127.0.0.1:${port}/_bridge/health`)).status, 200); assert.equal(requests.length, 0); } finally { await runtime.close(); } });
test('broker OIDC contract keeps vendors local', async () => { const requests = []; const { runtime, port } = await runtimeFor({ async getValidatedAccessToken() { return null; } }, requests); try { assert.equal((await fetch(`http://127.0.0.1:${port}/_bridge/vendors`)).status, 200); assert.equal(requests.length, 0); } finally { await runtime.close(); } });
for (const [label, adapter] of [
  ['missing', { async getValidatedAccessToken() { return null; } }],
  ['expired', { async getValidatedAccessToken() { return { accessToken: 'old', expiresAt: 1 }; } }],
  ['malformed', { async getValidatedAccessToken() { return { accessToken: '', expiresAt: Date.now() + 1_000 }; } }],
  ['thrown', { async getValidatedAccessToken() { throw new Error('nope'); } }],
]) test(`broker OIDC contract ${label} session returns exact local 401 with zero fetch`, async () => { const requests = []; const { runtime, port } = await runtimeFor(adapter, requests); try { const responseValue = await fetch(`http://127.0.0.1:${port}/openai/v1/responses`); assert.equal(responseValue.status, 401); assert.equal(await responseValue.text(), LOGIN_REQUIRED); assert.equal(requests.length, 0); } finally { await runtime.close(); } });
test('broker OIDC contract forwards exactly one bearer to the fixed broker', async () => { const requests = []; const { runtime, port } = await runtimeFor({ async getValidatedAccessToken() { return { accessToken: 'distinctive-token', expiresAt: Date.now() + 60_000 }; } }, requests); try { const result = await fetch(`http://127.0.0.1:${port}/openai/v1/responses?x=1`, { headers: { authorization: 'Bearer caller', 'x-api-key': 'caller-key', 'x-safe': 'yes' } }); assert.equal(result.status, 201); assert.equal(requests.length, 1); assert.equal(requests[0].url, `${brokerBase}/openai/v1/responses?x=1`); assert.equal(requests[0].options.headers.authorization, 'Bearer distinctive-token'); assert.equal(requests[0].options.headers['x-api-key'], undefined); assert.equal(requests[0].options.headers['x-safe'], 'yes'); } finally { await runtime.close(); } });
test('broker OIDC contract preserves no bearer on local errors', async () => { const requests = []; const { runtime, port } = await runtimeFor({ async getValidatedAccessToken() { return undefined; } }, requests); try { await fetch(`http://127.0.0.1:${port}/vendor`, { headers: { authorization: 'Bearer caller' } }); assert.equal(requests.length, 0); } finally { await runtime.close(); } });
