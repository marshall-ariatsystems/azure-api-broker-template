import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL(`../dist/broker-bridge${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const bundle = fileURLToPath(new URL('../dist/broker-bridge.cjs', import.meta.url));
const banned = /DefaultAzureCredential|@azure\/identity|broker\.env|refresh_token|client_secret|keytar/g;
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const bootstrapMessage = 'Broker discovery URL must include public OIDC bootstrap parameters: oidc_issuer, oidc_client_id, and oidc_audience.';

function childExit(child) { return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
function execute(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { ...options, env: options.env }); let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject); childExit(child).then((result) => resolve({ ...result, stdout, stderr }), reject);
  });
}
function snapshot(directory) {
  if (!existsSync(directory)) return [];
  const walk = (current, relative = '') => readdirSync(current).flatMap((entry) => {
    const location = join(current, entry); const item = `${relative}${entry}`; const stat = statSync(location);
    return stat.isDirectory() ? [item + '/', ...walk(location, item + '/')] : [item];
  });
  return walk(directory).sort();
}

if (!existsSync(binary)) {
  test('packaged binary absent (informational; run npm run bundle && npm run package)', () => assert.equal(existsSync(binary), false));
} else {
  test('packaged binary reports its version', async () => {
    const home = await mkdtemp(join(tmpdir(), 'broker-bridge-home-'));
    const result = await execute(['--version'], { env: { HOME: home } });
    assert.equal(result.code, 0); assert.equal(result.stdout, 'broker-bridge 0.1.0\n'); assert.equal(result.stderr, '');
  });

  test('packaged binary clean machine rejects offline input without persistence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'broker-bridge-cwd-')); const home = await mkdtemp(join(tmpdir(), 'broker-bridge-home-')); const temp = await mkdtemp(join(tmpdir(), 'broker-bridge-tmp-'));
    const before = [snapshot(cwd), snapshot(home), snapshot(temp)]; const options = { cwd, env: { HOME: home, TMPDIR: temp } };
    const version = await execute(['--version'], options); assert.equal(version.code, 0); assert.equal(version.stdout, 'broker-bridge 0.1.0\n');
    const usage = await execute([], options); assert.equal(usage.code, 2); assert.match(usage.stderr, /Usage:/);
    const serve = await execute(['serve', '--broker', 'https://broker.invalid/discovery'], options); assert.equal(serve.code, 2); assert.match(serve.stderr, new RegExp(bootstrapMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const run = await execute(['run', '--broker', 'https://broker.invalid/discovery', '--', 'does-not-exist-app'], options); assert.notEqual(run.code, 0); assert.match(run.stderr, new RegExp(bootstrapMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual([snapshot(cwd), snapshot(home), snapshot(temp)], before);
  }, { timeout: 15_000 });

  test('packaged binary stateless artifact contains no legacy credential surface', () => {
    for (const bytes of [readFileSync(bundle), readFileSync(binary)]) { banned.lastIndex = 0; assert.equal([...bytes.toString('utf8').matchAll(banned)].length, 0); }
    assert.equal(readFileSync(binary).includes(Buffer.from(fuse)), true);
  });
}
