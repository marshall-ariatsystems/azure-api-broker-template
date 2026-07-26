import assert from 'node:assert/strict';
import test from 'node:test';
import { clearSession, getAccessToken, setAccessToken } from '../session.mjs';
import { createProductionSessionAdapter, main, oidcBootstrapFromDiscoveryUrl } from '../broker-bridge.mjs';

test('login and run uses a RAM-only session', () => {
  const now = Date.now();
  setAccessToken('temporary', now + 1_000);
  assert.equal(getAccessToken(now), 'temporary');
  clearSession();
  assert.equal(getAccessToken(now), undefined);
});

test('restart session has no persisted token', () => assert.equal(getAccessToken(), undefined));

test('production session adapter performs same-process public login and exposes only the current bearer', async () => {
  clearSession();
  let config;
  const adapter = await createProductionSessionAdapter({
    brokerDiscoveryUrl: 'https://broker.example/discovery?oidc_issuer=https%3A%2F%2Fissuer.example&oidc_client_id=public-client&oidc_audience=broker',
    loginFlow: async (value) => { config = value; setAccessToken('same-process-bearer', Date.now() + 1_000); },
    present: () => { throw new Error('test login flow owns presentation'); },
  });
  assert.deepEqual(config, { issuer: 'https://issuer.example', clientId: 'public-client', audience: 'broker', scopes: 'openid' });
  assert.deepEqual(await adapter.getValidatedAccessToken({ now: Date.now() }), { accessToken: 'same-process-bearer', expiresAt: Number.MAX_SAFE_INTEGER });
  assert.throws(() => oidcBootstrapFromDiscoveryUrl('https://broker.example/discovery'), /public OIDC bootstrap/);
  clearSession();
});

test('serve CLI composes its login adapter into the same runtime process', async () => {
  const seen = {};
  const originalError = console.error; console.error = () => {};
  let code;
  try { code = await main(['serve', '--broker', 'https://broker.example/discovery?oidc_issuer=https%3A%2F%2Fissuer.example&oidc_client_id=public-client&oidc_audience=broker'], {
    createSessionAdapter: async ({ brokerDiscoveryUrl }) => ({ async getValidatedAccessToken() { return { accessToken: brokerDiscoveryUrl, expiresAt: Date.now() + 1_000 }; } }),
    createRuntime: (options) => { seen.options = options; return { async listen() { throw new Error('fixture stop'); }, async close() {} }; },
  }); } finally { console.error = originalError; }
  assert.equal(code, 2);
  assert.equal(typeof seen.options.sessionAdapter.getValidatedAccessToken, 'function');
  assert.match((await seen.options.sessionAdapter.getValidatedAccessToken()).accessToken, /oidc_client_id=public-client/);
});

test('run CLI logs in before it starts the in-process bridge and passes only generated compatibility values to its application launcher', async () => {
  let options; const events = [];
  const code = await main(['run', '--broker', 'https://broker.example/discovery?oidc_issuer=https%3A%2F%2Fissuer.example&oidc_client_id=public-client&oidc_audience=broker', '--preset', 'openai', '--', 'node', 'app.mjs'], {
    createSessionAdapter: async () => ({ async getValidatedAccessToken() { return { accessToken: 'same-process-bearer', expiresAt: Date.now() + 1_000 }; }, async clear() { events.push('clear'); } }),
    createRuntime: () => ({ async listen() { events.push('listen'); }, async close() { events.push('close'); } }),
    runLauncher: async (value) => { events.push('launch'); options = value; return 7; },
  });
  assert.equal(code, 7);
  assert.deepEqual(events, ['listen', 'launch', 'clear', 'close']);
  assert.equal(options.brokerDiscoveryUrl.includes('oidc_client_id=public-client'), true);
  assert.equal(options.bridgeAlreadyRunning, true);
  assert.deepEqual(options.compatibilityEnv, { OPENAI_BASE_URL: 'http://127.0.0.1:8079/openai/v1', OPENAI_API_KEY: 'broker-managed' });
});
