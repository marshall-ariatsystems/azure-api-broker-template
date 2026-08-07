#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const TARGET_SCHEMA = 1;
function fail(message) { throw new Error(message); }
function run(args, { json = false } = {}) {
  const result = spawnSync('az', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) fail((result.stderr || result.stdout || 'Azure CLI failed').trim());
  return json ? JSON.parse(result.stdout || 'null') : result.stdout.trim();
}
function parse(argv) { const out = { command: argv[0] }; for (let i = 1; i < argv.length; i += 2) { if (!argv[i]?.startsWith('--') || !argv[i + 1]) fail('usage: migrate.mjs plan|apply --account <storage-account> [--release <version>]'); out[argv[i].slice(2)] = argv[i + 1]; } return out; }
function documents(account) {
  const output = run(['storage', 'entity', 'query', '--account-name', account, '--auth-mode', 'login', '--table-name', 'brokerPolicy', '-o', 'json'], { json: true });
  return Array.isArray(output) ? output : output.items || [];
}
function inspect(rows) {
  return rows.map((row) => {
    let document; try { document = JSON.parse(row.document); } catch { fail(`policy ${row.RowKey} is not valid JSON`); }
    const version = Number(document.schemaVersion || 1); if (!Number.isInteger(version) || version < 1 || version > TARGET_SCHEMA) fail(`policy ${row.RowKey} has unsupported schema ${version}`);
    return { row, document, version, change: version < TARGET_SCHEMA ? `upgrade ${version} -> ${TARGET_SCHEMA}` : 'none' };
  });
}
function snapshot(account, release, item) {
  const digest = createHash('sha256').update(item.row.RowKey).digest('hex').slice(0, 16);
  run(['storage', 'entity', 'insert', '--account-name', account, '--auth-mode', 'login', '--table-name', 'brokerPolicySnapshots', '--if-exists', 'fail', '--entity', `PartitionKey=${release}`, `RowKey=${digest}`, `policyKey=${item.row.RowKey}`, `document=${item.row.document}`, `schemaVersion=${item.version}`, `capturedAt=${new Date().toISOString()}`]);
}
function apply(account, release, items) {
  run(['storage', 'table', 'create', '--account-name', account, '--auth-mode', 'login', '--name', 'brokerPolicySnapshots']);
  for (const item of items) {
    snapshot(account, release, item);
    if (item.change !== 'none') {
      const next = JSON.stringify({ ...item.document, schemaVersion: TARGET_SCHEMA });
      run(['storage', 'entity', 'insert', '--account-name', account, '--auth-mode', 'login', '--table-name', 'brokerPolicy', '--if-exists', 'replace', '--entity', 'PartitionKey=policy', `RowKey=${item.row.RowKey}`, `document=${next}`, `schemaVersion=${TARGET_SCHEMA}`, `updatedAt=${new Date().toISOString()}`]);
    }
  }
}

try {
  const options = parse(process.argv.slice(2)); if (!['plan', 'apply'].includes(options.command) || !options.account) fail('usage: migrate.mjs plan|apply --account <storage-account> [--release <version>]');
  const release = options.release || `schema-${TARGET_SCHEMA}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const items = inspect(documents(options.account));
  process.stdout.write(`${JSON.stringify({ targetSchema: TARGET_SCHEMA, release, documents: items.map((item) => ({ key: item.row.RowKey, currentSchema: item.version, change: item.change })), secretsRead: false }, null, 2)}\n`);
  if (options.command === 'apply') { apply(options.account, release, items); process.stdout.write(`Migration snapshot ${release} recorded and compatible transforms applied.\n`); }
} catch (error) { process.stderr.write(`migrate: ${error.message}\n`); process.exitCode = 1; }
