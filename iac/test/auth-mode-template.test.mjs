import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
test('auth modes explicitly preserve Entra and generic OIDC handoff', async () => {
  const text = await readFile(new URL('../auth.bicep', import.meta.url), 'utf8');
  const foundation = await readFile(new URL('../foundation.bicep', import.meta.url), 'utf8');
  assert.match(text, /@allowed\(\['entra', 'generic-oidc'\]\)/); assert.match(text, /platform: \{ enabled: authMode == 'entra' \}/); assert.match(text, /requireAuthentication: authMode == 'entra'/); assert.match(text, /unauthenticatedClientAction: 'Return401'/); assert.match(text, /enabled: authMode == 'entra'/); assert.doesNotMatch(text, /clientSecret/i);
  for (const name of ['AUTH_MODE', 'GENERIC_OIDC_ISSUER', 'GENERIC_OIDC_AUDIENCE', 'GENERIC_OIDC_CLAIM_MAP', 'GENERIC_OIDC_ASSURANCE']) assert.match(foundation, new RegExp(`${name}:`));
  assert.doesNotMatch(foundation, /GENERIC_OIDC_CLIENT_SECRET|clientSecret/i);
});
