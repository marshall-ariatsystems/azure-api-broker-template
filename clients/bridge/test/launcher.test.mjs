import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compatibilityEnvironment, parseCli } from '../cli.mjs';
import { exitCodeForSignal, runApplication } from '../launcher.mjs';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const fixtureBridge = new URL('./fixtures/healthy-bridge.mjs', import.meta.url).pathname;

test('run parser accepts a config, preset, mappings, and an application', () => {
  assert.deepEqual(parseCli(['run', '--config', 'team.env', '--preset', 'openai', '--set', 'MY_KEY=broker-managed', '--', 'node', 'app.mjs']), {
    command: 'run', config: 'team.env', preset: 'openai', mappings: ['MY_KEY=broker-managed'], application: ['node', 'app.mjs'],
  });
  assert.match(parseCli(['run', '--preset', 'openai']).error, /requires an application/);
});

test('compatibility environment contains only local URLs and placeholders', () => {
  assert.deepEqual(compatibilityEnvironment({ preset: 'openai', vendor: 'openai', host: '127.0.0.1', port: 8079 }), {
    OPENAI_BASE_URL: 'http://127.0.0.1:8079/openai/v1', OPENAI_API_KEY: 'broker-managed',
  });
  assert.throws(
    () => compatibilityEnvironment({ preset: 'openai', vendor: 'openai', host: '127.0.0.1', port: 8079, mappings: ['MY_KEY=sk-real-key'] }),
    /bridge loopback URL or the `broker-managed` placeholder/,
  );
});

test('signal exit codes retain the conventional process status', () => {
  assert.equal(exitCodeForSignal('SIGINT'), 130);
  assert.equal(exitCodeForSignal('SIGTERM'), 143);
});

test('run launches an application after bridge health and stops the bridge', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-run-'));
  const resultPath = join(cwd, 'environment.json');
  const port = await unusedPort();
  const exitCode = await runApplication({
    application: [process.execPath, '-e', "require('fs').writeFileSync(process.env.TEST_RESULT_PATH, JSON.stringify({ url: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY }))"],
    configPath: 'broker.env', cwd, host: '127.0.0.1', port,
    bridgeScript: fixtureBridge,
    environment: { ...process.env, TEST_BRIDGE_PORT: String(port), TEST_RESULT_PATH: resultPath },
    compatibilityEnv: { OPENAI_BASE_URL: `http://127.0.0.1:${port}/openai/v1`, OPENAI_API_KEY: 'broker-managed' },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), {
    url: `http://127.0.0.1:${port}/openai/v1`, key: 'broker-managed',
  });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/_bridge/health`));
});

test('run preserves a failing application exit code', async () => {
  const port = await unusedPort();
  const exitCode = await runApplication({
    application: [process.execPath, '-e', 'process.exit(7)'], configPath: 'broker.env',
    host: '127.0.0.1', port, bridgeScript: fixtureBridge,
    environment: { ...process.env, TEST_BRIDGE_PORT: String(port) }, compatibilityEnv: {},
  });
  assert.equal(exitCode, 7);
});

test('run reports a health timeout and stops the bridge', async () => {
  const port = await unusedPort();
  await assert.rejects(
    runApplication({
      application: [process.execPath, '-e', 'process.exit(0)'], configPath: 'broker.env',
      host: '127.0.0.1', port, bridgeScript: fixtureBridge, healthTimeoutMs: 150,
      environment: { ...process.env, TEST_BRIDGE_PORT: String(port), TEST_BRIDGE_HEALTHY: 'false' }, compatibilityEnv: {},
    }),
    /Bridge health check timed out/,
  );
  await assert.rejects(fetch(`http://127.0.0.1:${port}/_bridge/health`));
});
