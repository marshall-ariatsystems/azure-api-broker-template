#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fail(message) { throw new Error(message); }
function run(command, args, { json = false } = {}) { const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); if (result.status !== 0) fail((result.stderr || result.stdout || `${command} failed`).trim()); return json ? JSON.parse(result.stdout || 'null') : result.stdout.trim(); }
function parse(argv) { const out = { command: argv[0] }; for (let i = 1; i < argv.length; i += 2) { if (!argv[i]?.startsWith('--') || !argv[i + 1]) fail('usage: connection-role.mjs plan|apply --vendor <vendor-id>'); out[argv[i].slice(2)] = argv[i + 1]; } return out; }
function roleValue(vendor) { return `VendorApi.${vendor.replace(/(^|-)[a-z]/g, (part) => part.replace('-', '').toUpperCase())}.Invoke`; }

try {
  const options = parse(process.argv.slice(2)); if (!['plan', 'apply'].includes(options.command) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.vendor || '')) fail('usage: connection-role.mjs plan|apply --vendor <vendor-id>');
  const clientId = run('azd', ['env', 'get-value', 'BROKER_CLIENT_ID']);
  const app = run('az', ['ad', 'app', 'show', '--id', clientId, '-o', 'json'], { json: true });
  const value = roleValue(options.vendor); const exists = (app.appRoles || []).find((role) => role.value === value);
  const plan = { vendor: options.vendor, role: value, action: exists ? 'none' : 'add', allowedAssignments: ['users', 'groups', 'service principals'] };
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  if (options.command === 'apply' && !exists) {
    const role = { allowedMemberTypes: ['User', 'Application'], description: `Invoke the ${options.vendor} broker connection.`, displayName: `${options.vendor} broker connection`, id: randomUUID(), isEnabled: true, origin: 'Application', value };
    run('az', ['rest', '--method', 'PATCH', '--url', `https://graph.microsoft.com/v1.0/applications/${app.id}`, '--headers', 'content-type=application/json', '--body', JSON.stringify({ appRoles: [...(app.appRoles || []), role] })]);
    process.stdout.write('Broker enterprise-application role added. Assign it in Entra, then add the matching connection grant in the admin console.\n');
  }
} catch (error) { process.stderr.write(`connection-role: ${error.message}\n`); process.exitCode = 1; }
