import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runNode(args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('run --preset anthropic gives the child the loopback preset environment', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-preset-'));
  const port = await unusedPort();
  const configPath = join(cwd, 'broker.env');
  const resultPath = join(cwd, 'environment.json');
  const fixturePath = join(cwd, 'print-environment.mjs');
  const bridgeScript = new URL('../broker-bridge.mjs', import.meta.url).pathname;
  await writeFile(configPath, [
    'BROKER_BASE=https://broker.example.test/api/broker',
    'BROKER_SCOPE=api://broker/.default',
    'BROKER_VENDOR=anthropic',
    `BRIDGE_PORT=${port}`,
  ].join('\n'));
  await writeFile(fixturePath, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.TEST_RESULT_PATH, JSON.stringify({ base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY }));\n");

  const result = await runNode([bridgeScript, 'run', '--config', 'broker.env', '--preset', 'anthropic', '--', process.execPath, fixturePath], cwd, {
    ...process.env,
    TEST_RESULT_PATH: resultPath,
  });

  assert.equal(result.code, 0, result.stderr);
  const observed = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.match(observed.base, /127\.0\.0\.1/);
  assert.match(observed.base, /\/anthropic/);
  assert.equal(observed.key, 'broker-managed');
});
