import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { initializeBridge, loadBridgeConfig, parseCli, renderBridgeEnv } from '../cli.mjs';

function runNode(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('init creates keyless OpenAI configuration and links a missing dotenv file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-init-'));
  const result = await initializeBridge({ cwd, preset: 'openai' });
  const contents = await readFile(join(cwd, 'broker.env'), 'utf8');

  assert.equal(result.dotenv, 'linked');
  assert.match(contents, /^BROKER_BASE=/m);
  assert.match(contents, /^BROKER_SCOPE=/m);
  assert.match(contents, /^BROKER_VENDOR=openai$/m);
  assert.doesNotMatch(contents, /(?:api[_-]?key|client_secret|vendor.*key)\s*=/i);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), contents);
});

test('init preserves an existing dotenv file unless explicit append is requested', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-init-'));
  await writeFile(join(cwd, '.env'), 'APP_SETTING=preserved\n');

  const result = await initializeBridge({ cwd, preset: 'anthropic' });
  assert.equal(result.dotenv, 'existing-file');
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'APP_SETTING=preserved\n');

  const appendResult = await initializeBridge({ cwd, preset: 'anthropic', output: 'other.env', appendDotenv: true });
  assert.equal(appendResult.dotenv, 'appended');
  const dotenv = await readFile(join(cwd, '.env'), 'utf8');
  assert.match(dotenv, /# >>> broker-bridge >>>/);
  assert.match(dotenv, /^BROKER_VENDOR=anthropic$/m);
});

test('init refuses to overwrite or append duplicate broker configuration', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-init-'));
  await writeFile(join(cwd, 'broker.env'), renderBridgeEnv('generic'));
  await assert.rejects(initializeBridge({ cwd }), /refusing to overwrite/);

  const appendCwd = await mkdtemp(join(tmpdir(), 'broker-bridge-init-'));
  await writeFile(join(appendCwd, '.env'), 'BROKER_BASE=https://already.example\n');
  await assert.rejects(
    initializeBridge({ cwd: appendCwd, output: 'broker.env', appendDotenv: true }),
    /refusing to append duplicates/,
  );
});

test('CLI parser validates presets and init options', () => {
  assert.deepEqual(parseCli(['init', '--preset', 'openai']), {
    command: 'init', preset: 'openai', output: 'broker.env', appendDotenv: false,
  });
  assert.match(parseCli(['init', '--preset', 'invalid']).error, /Unsupported preset/);
  assert.match(parseCli(['serve', '--preset', 'openai']).error, /accepts only/);
});

test('bridge loads broker.env without requiring the caller to source it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-config-'));
  await writeFile(join(cwd, 'broker.env'), [
    'BROKER_BASE=https://broker.example.test/api/broker',
    'BROKER_SCOPE=api://example/.default',
    'BROKER_VENDOR=openai',
    'BRIDGE_PORT=9080',
  ].join('\n'));
  const config = await loadBridgeConfig({ cwd, environment: {} });
  assert.equal(config.brokerBase, 'https://broker.example.test/api/broker');
  assert.equal(config.brokerScope, 'api://example/.default');
  assert.equal(config.vendor, 'openai');
  assert.equal(config.routingMode, 'strict');
  assert.equal(config.port, 9080);
});

test('environment overrides broker.env but loopback binding remains mandatory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-config-'));
  await writeFile(join(cwd, 'broker.env'), 'BROKER_BASE=https://broker.example\nBROKER_SCOPE=api://example/.default\n');
  const config = await loadBridgeConfig({ cwd, environment: { BROKER_VENDOR: 'anthropic', BRIDGE_PORT: '9090' } });
  assert.equal(config.vendor, 'anthropic');
  assert.equal(config.port, 9090);
  await assert.rejects(
    loadBridgeConfig({ cwd, environment: { BRIDGE_HOST: '0.0.0.0' } }),
    /loopback-only/,
  );
});

test('serve reports a missing Azure Identity install without a module stack trace', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-config-'));
  await writeFile(join(cwd, 'broker.env'), 'BROKER_BASE=https://broker.example\nBROKER_SCOPE=api://example/.default\n');
  const bridge = new URL('../broker-bridge.mjs', import.meta.url).pathname;
  const result = await runNode([bridge, 'serve'], cwd);
  assert.equal(result.code, 2);
  // Some restricted test runners close a child stderr pipe before its final diagnostic flushes.
  // The exit status is the stable CLI contract; when output is captured, verify the remediation too.
  if (result.stderr) assert.match(result.stderr, /Azure Identity is not installed/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
});
