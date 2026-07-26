import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bridgePath = fileURLToPath(new URL(`../dist/broker-bridge${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForHealth(url, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The child may still be binding its loopback listener.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Bridge health check timed out after ${timeoutMs}ms: ${url}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = childExit(child);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
  try { await exited; } finally { clearTimeout(timeout); }
}

if (!existsSync(bridgePath)) {
  test('packaged bridge is available', (t) => {
    t.skip('dist/broker-bridge not built — run npm run bundle && npm run package');
  });
} else {
  test('packaged bridge reports its version', async () => {
    const child = spawn(bridgePath, ['--version']);
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const result = await childExit(child);
    assert.equal(result.code, 0);
    assert.equal(stdout.trim(), 'broker-bridge 1.0.0');
  });

  test('packaged bridge serves its health endpoint', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-packaged-'));
    await writeFile(join(cwd, 'broker.env'), [
      'BROKER_BASE=https://example.invalid/broker',
      'BROKER_SCOPE=api://example/.default',
      'BRIDGE_PORT=8179',
      '',
    ].join('\n'));
    const child = spawn(bridgePath, ['serve', '--config', join(cwd, 'broker.env')], { cwd });
    const exited = childExit(child);
    try {
      const response = await waitForHealth('http://127.0.0.1:8179/_bridge/health');
      assert.equal(response.status, 200);
    } finally {
      await stop(child);
    }
    const result = await exited;
    assert.equal(result.signal, 'SIGTERM');
  });
}
