import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SUPPORTED_NODE_ENGINES, SUPPORTED_NODE_MAJOR } from '../src/supported-node.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const bridgeDirectory = resolve(testDirectory, '..');
const repositoryRoot = resolve(bridgeDirectory, '../..');

test('node support boundary is one consistent value', () => {
  const packageJson = JSON.parse(readFileSync(resolve(bridgeDirectory, 'package.json'), 'utf8'));
  const readme = readFileSync(resolve(bridgeDirectory, 'README.md'), 'utf8');
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/release-bridge.yml'), 'utf8');
  const evidence = readFileSync(resolve(bridgeDirectory, 'scripts/release-evidence.mjs'), 'utf8');

  assert.equal(packageJson.engines.node, SUPPORTED_NODE_ENGINES);
  assert.match(readme, new RegExp(`require Node ${SUPPORTED_NODE_MAJOR}`, 'i'));
  assert.equal(Number(/^\s*node-version:\s*(\d+)\s*$/m.exec(workflow)?.[1]), SUPPORTED_NODE_MAJOR);
  assert.match(evidence, /import \{ SUPPORTED_NODE_MAJOR \} from '\.\.\/src\/supported-node\.mjs';/);
  assert.match(evidence, /supportedNodeMajor:\s*SUPPORTED_NODE_MAJOR/);
});
