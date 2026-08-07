#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

function fail(message) { throw new Error(message); }
function run(command, args, { allowFailure = false } = {}) { const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); if (result.status !== 0 && !allowFailure) fail((result.stderr || result.stdout || `${command} failed`).trim()); return result.status === 0 ? result.stdout.trim() : ''; }
function env(name) { return process.env[name] || run('azd', ['env', 'get-value', name], { allowFailure: true }); }

try {
  run('az', ['account', 'show', '--query', 'user.type', '-o', 'tsv']);
  const location = env('AZURE_LOCATION'); if (!location) fail('AZURE_LOCATION is required');
  const environment = env('AZURE_ENV_NAME'); if (!/^[a-z0-9][a-z0-9-]{1,19}$/.test(environment)) fail('AZURE_ENV_NAME must be 2-20 lowercase letters, digits, or hyphens');
  const required = ['AZURE_TAG_COST_CENTER', 'AZURE_TAG_OWNER', 'AZURE_TAG_WORKLOAD', 'AZURE_TAG_ENVIRONMENT'];
  const missing = required.filter((name) => !env(name)); if (missing.length) fail(`set required resource-group tags with azd env set: ${missing.join(', ')}`);
  const runtimes = JSON.parse(run('az', ['functionapp', 'list-flexconsumption-runtimes', '--location', location, '--runtime', 'node', '-o', 'json']));
  const node22 = runtimes.some((runtime) => runtime.name === 'node' && runtime.version === '22');
  if (!node22) fail(`Node.js 22 Flex Consumption is unavailable in ${location}`);
  for (const provider of ['Microsoft.Web', 'Microsoft.App', 'Microsoft.Storage', 'Microsoft.KeyVault', 'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights', 'Microsoft.Insights']) {
    const status = run('az', ['provider', 'show', '--namespace', provider, '--query', 'registrationState', '-o', 'tsv']);
    if (status.toLowerCase() !== 'registered') fail(`${provider} is not registered; no registration was changed`);
  }
  process.stdout.write(`Preflight passed for ${location}; no Azure resources were changed.\n`);
} catch (error) { process.stderr.write(`preflight: ${error.message}\n`); process.exitCode = 1; }
