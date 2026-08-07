import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const template = JSON.parse(await readFile(new URL('../../infra/azuredeploy.json', import.meta.url), 'utf8'));

test('portal deployment template includes identity and package bootstrap inputs', () => {
  assert.equal(template.languageVersion, '2.0');
  assert.equal(template.imports.MicrosoftGraph.provider, 'MicrosoftGraph');
  for (const name of ['operatorObjectId', 'brokerPackageUri', 'adminPackageUri']) assert.ok(template.parameters[name], `${name} must be a template parameter`);
  assert.match(template.parameters.brokerPackageUri.defaultValue, /releases\/download\/v0\.3\.0\/broker\.zip\?download=1$/);
  assert.match(template.parameters.adminPackageUri.defaultValue, /releases\/download\/v0\.3\.0\/admin\.zip\?download=1$/);
});

test('portal deployment template exposes generated identity and app endpoints', () => {
  const outputNames = Object.keys(template.outputs);
  for (const name of ['AZURE_BROKER_URL', 'AZURE_ADMIN_URL', 'BROKER_CLIENT_ID', 'ADMIN_CLIENT_ID', 'ADMIN_SERVICE_PRINCIPAL_ID']) assert.ok(outputNames.includes(name), `${name} must be an output`);
});
