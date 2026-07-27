import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { KNOWN_GOOD_REVISIONS, extractUses, validateFiles, validateReleaseContract, validateWorkflow } from '../scripts/verify-release-actions.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');
const workflows = [
  resolve(repositoryRoot, '.github/workflows/release-bridge.yml'),
  resolve(repositoryRoot, '.github/workflows/release-client.yml'),
];

test('release action pins resolve to reviewed immutable revisions', () => {
  assert.deepEqual(validateFiles(workflows), []);
  assert.deepEqual(validateReleaseContract(
    readFileSync(workflows[0], 'utf8'),
    readFileSync(workflows[1], 'utf8'),
  ), []);
  for (const workflow of workflows) {
    for (const uses of extractUses(readFileSync(workflow, 'utf8'))) {
      const match = /^([^@]+)@([a-f0-9]{40})$/i.exec(uses);
      assert.ok(match, `${uses} is not an immutable pin`);
      assert.equal(KNOWN_GOOD_REVISIONS[match[1]], match[2], `${uses} is not allow-listed`);
    }
  }
  assert.notDeepEqual(validateWorkflow('  - uses: actions/checkout@main\n'), []);
  assert.notDeepEqual(validateWorkflow('  - uses: actions/checkout@0000000000000000000000000000000000000000\n'), []);
  assert.notDeepEqual(validateReleaseContract('', ''), []);
});
