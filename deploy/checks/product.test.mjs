import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../lib/product.mjs';

test('key plan is local, deterministic, and does not require an Azure command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tessera-cli-test-'));
  const state = join(directory, 'state.json');
  writeFileSync(state, JSON.stringify({ admin: { appId: 'public-id', url: 'https://admin.example/console' } }));
  const output = []; const original = process.stdout.write;
  process.stdout.write = (value) => { output.push(String(value)); return true; };
  try { await main(['key', 'plan', '--state', state, '--vendor', 'example-vendor', '--name', 'Production Key']); } finally { process.stdout.write = original; }
  const plan = JSON.parse(output.join(''));
  assert.equal(plan.role, 'VendorApi.ExampleVendor.Invoke');
  assert.equal(plan.keyVaultSecretName, 'example-vendor-production-key');
});

test('help is available without Azure credentials', async () => {
  const output = []; const original = process.stdout.write;
  process.stdout.write = (value) => { output.push(String(value)); return true; };
  try { await main(['--help']); } finally { process.stdout.write = original; }
  assert.match(output.join(''), /doctor --config/);
});
