import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the deployment-local SDK stays synchronized with the root SDK', async () => {
  const rootSdk = await readFile(new URL('../../sdk/index.js', import.meta.url), 'utf8');
  const vendoredSdk = await readFile(new URL('../vendor/build-sdk/index.js', import.meta.url), 'utf8');

  assert.equal(vendoredSdk, rootSdk);
});
