import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION } from '../version.mjs';

const bridgeDir = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(bridgeDir);
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const pattern = 'DefaultAzureCredential|@azure/identity|broker\\.env|refresh_token|client_secret|keytar';
const banned = new RegExp(pattern, 'g');
const bundleFile = 'dist/broker-bridge.cjs';
const binaryFile = `dist/broker-bridge${process.platform === 'win32' ? '.exe' : ''}`;
const evidenceFile = '../../_directives/ED/ED-V007-002-artifact-evidence.json';
const deferred = [
  { item: 'windows-signing', until: 'first bridge-v* tag', mechanism: '.github/workflows/release-bridge.yml:83-97' },
  { item: 'provenance-attestation', until: 'first bridge-v* tag', mechanism: '.github/workflows/release-bridge.yml:142-145' },
  { item: 'multi-platform-builds', until: 'first bridge-v* tag', mechanism: '.github/workflows/release-bridge.yml:56-74' },
  { item: 'github-release-publication', until: 'first bridge-v* tag', mechanism: '.github/workflows/release-bridge.yml:147-152' },
];

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function artifact(file) { const bytes = readFileSync(file); return { file, sha256: hash(bytes), bytes: bytes.length }; }
function scan(files) { return files.reduce((count, file) => { banned.lastIndex = 0; return count + [...readFileSync(file).toString('utf8').matchAll(banned)].length; }, 0); }
function requireArtifacts() { for (const file of [bundleFile, binaryFile]) if (!existsSync(file)) throw new Error(`${file} not found; run npm run bundle && npm run package first`); }
function rebuildMatches() {
  const directory = mkdtempSync(join(tmpdir(), 'broker-bridge-evidence-')); const output = join(directory, 'broker-bridge.cjs');
  try { execFileSync('npx', ['esbuild', 'broker-bridge.mjs', '--bundle', '--platform=node', '--format=cjs', `--outfile=${output}`], { stdio: 'ignore' }); return hash(readFileSync(bundleFile)) === hash(readFileSync(output)); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function compare(field, expected, actual) { if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function recomputed() {
  requireArtifacts(); const files = [bundleFile, binaryFile]; const matches = scan(files); if (matches) throw new Error(`stateless scan matched ${matches} banned pattern(s)`);
  const rebuild = rebuildMatches(); if (!rebuild) throw new Error('stale dist — rerun npm run bundle');
  const sbom = JSON.parse(execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'], { encoding: 'utf8' }));
  return { artifacts: files.map(artifact), reproducible: { bundleRebuildSha256Match: rebuild }, statelessScan: { pattern, matches }, seaHost: { fusePresent: readFileSync(binaryFile).includes(Buffer.from(fuse)) }, sbom: { bomFormat: sbom.bomFormat, specVersion: sbom.specVersion } };
}

try {
  const current = recomputed();
  if (!current.seaHost.fusePresent) throw new Error('seaHost.fusePresent: expected true, got false');
  if (process.argv[2] === '--verify') {
    const recorded = JSON.parse(readFileSync(evidenceFile, 'utf8'));
    compare('ed', 'ED-V007-002', recorded.ed); compare('version', BRIDGE_VERSION, recorded.version); compare('platform', `${process.platform}-${process.arch}`, recorded.platform);
    for (const key of ['artifacts', 'reproducible', 'statelessScan', 'seaHost']) compare(key, recorded[key], current[key]);
    compare('sbom.bomFormat', recorded.sbom?.bomFormat, current.sbom.bomFormat); compare('sbom.specVersion', recorded.sbom?.specVersion, current.sbom.specVersion);
    compare('deferred.items', deferred.map(({ item }) => item), recorded.deferred?.map(({ item }) => item));
    console.log(evidenceFile);
  } else {
    const record = { ed: 'ED-V007-002', version: BRIDGE_VERSION, generatedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, ...current, deferred };
    const temporary = `${evidenceFile}.tmp.${process.pid}`; writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`); renameSync(temporary, evidenceFile); console.log(evidenceFile);
  }
} catch (error) { console.error(error.message); process.exit(1); }
