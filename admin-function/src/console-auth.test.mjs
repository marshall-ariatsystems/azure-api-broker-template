import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('console determines sign-in through the protected management API', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /\/\.auth\/me/);
  assert.match(source, /error\.status = response\.status/);
  assert.match(source, /error\.status === 401/);
  assert.match(source, /error\.status === 403/);
});
