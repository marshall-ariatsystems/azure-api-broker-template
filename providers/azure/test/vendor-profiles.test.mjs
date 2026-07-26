import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const catalog = JSON.parse(await readFile(new URL('../vendor-profiles.json', import.meta.url), 'utf8'));

test('vendor profile catalog contains the six managed-service targets without credentials', () => {
  assert.deepEqual(Object.keys(catalog.profiles).sort(), [
    'cipp', 'datto-rmm', 'it-glue', 'meraki', 'microsoft-graph', 'salesforce',
  ]);
  const serialized = JSON.stringify(catalog).toLowerCase();
  assert.doesNotMatch(serialized, /client_secret\s*[:=]|api[_-]?key\s*[:=]|access_token\s*[:=]/);
  for (const profile of Object.values(catalog.profiles)) {
    assert.match(profile.route, /^[a-z0-9-]+$/);
    assert.ok(profile.auth.mode);
    assert.ok(profile.secretContract);
    assert.ok(profile.status);
  }
});
