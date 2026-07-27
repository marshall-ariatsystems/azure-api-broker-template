import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const stateDir = join(root, '.tessera');
const role = (value, allowedMemberTypes) => ({ allowedMemberTypes, description: value, displayName: value, id: randomUUID(), isEnabled: true, origin: 'Application', value });
const usage = `Usage:
  node deploy/tessera.mjs doctor --config <file>
  node deploy/tessera.mjs deploy --config <file> [--dry-run]
  node deploy/tessera.mjs outputs --state <file>
  node deploy/tessera.mjs key plan --state <file> --vendor <id> --name <display-name> [--type api_key]
  node deploy/tessera.mjs vendor add --state <file> --id <vendor-id> --name <display-name> --auth <api-key|bearer|basic|oauth2cc|entra>
  node deploy/tessera.mjs vendor provision --state <file> --id <vendor-id> --name <display-name> --auth <type> --base-url <https-url> --secret-file <path>
  node deploy/tessera.mjs principal set --state <file> --id <user:object-id> --name <display-name>
  node deploy/tessera.mjs grant --state <file> --connection <id> --kind <user|group|workload> --subject <kind:object-id>`;

function fail(message) { throw new Error(message); }
function command(commandName, args, { json = false, dryRun = false, cwd = root } = {}) {
  const printable = [commandName, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
  if (dryRun) { process.stdout.write(`[dry-run] ${printable}\n`); return json ? {} : ''; }
  const result = spawnSync(commandName, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) fail(`${printable}\n${result.stderr || result.stdout || 'command failed'}`.trim());
  return json ? JSON.parse(result.stdout || '{}') : result.stdout.trim();
}
function parse(argv) {
  const positional = []; const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const name = value.slice(2);
    if (name === 'dry-run' || name === 'help') { options[name === 'dry-run' ? 'dryRun' : 'help'] = true; continue; }
    const next = argv[++i]; if (!next || next.startsWith('--')) fail(`--${name} requires a value`);
    options[name] = next;
  }
  return { positional, options };
}
function config(file) {
  if (!file || !existsSync(file)) fail('--config must reference an existing JSON file');
  let value; try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('deployment configuration is not valid JSON'); }
  const required = ['resourceGroup', 'location', 'environment', 'operatorAllowedCidrs', 'network'];
  if (!value || typeof value !== 'object' || required.some((key) => !(key in value))) fail('deployment configuration is missing required fields; start from deploy/config.example.json');
  if (!/^[A-Za-z0-9_.()-]{1,90}$/.test(value.resourceGroup) || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(value.environment)) fail('resourceGroup or environment is invalid');
  const validCidr = (cidr) => { const [address, prefix] = String(cidr).split('/'); return Boolean(isIP(address)) && (prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (isIP(address) === 4 ? 32 : 128))); };
  if (!Array.isArray(value.operatorAllowedCidrs) || !value.operatorAllowedCidrs.length || value.operatorAllowedCidrs.some((cidr) => !validCidr(cidr) || cidr === '0.0.0.0/0' || cidr === '::/0')) fail('operatorAllowedCidrs must contain explicit valid non-public CIDRs');
  if (!value.network || value.network.mode !== 'isolated' || !Array.isArray(value.network.addressPrefixes) || !value.network.addressPrefixes.length || !value.network.integrationSubnetCidr || !value.network.privateEndpointSubnetCidr || !value.network.adminIntegrationSubnetCidr) fail('only network.mode "isolated" with three explicit non-overlapping CIDRs is currently supported');
  return Object.freeze(value);
}
function suffix(value) { return createHash('sha256').update(value).digest('hex').slice(0, 8); }
function names(input) { const id = suffix(`${input.resourceGroup}:${input.environment}`); return Object.freeze({ suffix: id, vnet: `ariat-${id}-vnet`, broker: `ariat-${id}-func`, admin: `ariat-${id}-admin` }); }
function appPayload(displayName, appRoles, redirectUris = []) { return { displayName, signInAudience: 'AzureADMyOrg', identifierUris: [], api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [{ adminConsentDescription: 'Access Tessera as the signed-in user.', adminConsentDisplayName: 'Access Tessera', id: randomUUID(), isEnabled: true, type: 'User', userConsentDescription: 'Access Tessera on your behalf.', userConsentDisplayName: 'Access Tessera', value: 'user_impersonation' }] }, appRoles, web: { redirectUris, implicitGrantSettings: { enableIdTokenIssuance: true, enableAccessTokenIssuance: false } } }; }
function graph(method, path, body, dryRun) { return command('az', ['rest', '--method', method, '--url', `https://graph.microsoft.com/v1.0${path}`, ...(body ? ['--body', JSON.stringify(body)] : [])], { json: true, dryRun }); }
function createApp(displayName, appRoles, redirectUris, dryRun) {
  if (!dryRun) {
    const existing = command('az', ['ad', 'app', 'list', '--display-name', displayName, '-o', 'json'], { json: true }).sort((a, b) => String(a.createdDateTime).localeCompare(String(b.createdDateTime)));
    if (existing.length) {
      const app = existing[0]; const servicePrincipal = command('az', ['ad', 'sp', 'show', '--id', app.appId, '-o', 'json'], { json: true });
      if (appRoles.length && !app.appRoles?.some((item) => item.value === 'Tessera.Operator')) graph('PATCH', `/applications/${app.id}`, { appRoles: [...(app.appRoles || []), ...appRoles] }, false);
      return { appId: app.appId, id: app.id, servicePrincipalId: servicePrincipal.id };
    }
  }
  const app = graph('POST', '/applications', appPayload(displayName, appRoles, redirectUris), dryRun);
  if (dryRun) return { appId: '<generated-app-id>', id: '<generated-object-id>', servicePrincipalId: '<generated-service-principal-id>' };
  graph('PATCH', `/applications/${app.id}`, { identifierUris: [`api://${app.appId}`] }, dryRun);
  const servicePrincipal = graph('POST', '/servicePrincipals', { appId: app.appId }, dryRun);
  return { appId: app.appId, id: app.id, servicePrincipalId: servicePrincipal.id };
}
function writeState(input, deployment) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, `${input.environment}.json`);
  const state = { version: 1, createdAt: new Date().toISOString(), subscriptionId: deployment.subscriptionId, resourceGroup: input.resourceGroup, location: input.location, environment: input.environment, broker: deployment.broker, admin: deployment.admin, appConfigEndpoint: deployment.appConfigEndpoint, keyVaultName: deployment.keyVaultName, storageAccountName: deployment.storageAccountName };
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return file;
}
function packageFunction(directory, dryRun) {
  // Flex Consumption OneDeploy only accepts this exact artifact name.
  const source = join(root, directory); const output = join(mkdtempSync(join(tmpdir(), 'ariat-package-')), 'released-package.zip');
  command('npm', ['ci', '--omit=dev'], { cwd: source, dryRun });
  const entries = ['host.json', 'package.json', 'package-lock.json', 'src', 'node_modules']; if (existsSync(join(source, 'public'))) entries.push('public');
  command('zip', ['-qr', output, ...entries], { cwd: source, dryRun });
  return output;
}
function deploymentArgs(resourceGroup, template, parameters) {
  const items = Object.entries(parameters).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return ['deployment', 'group', 'create', '--resource-group', resourceGroup, '--template-file', template, '--parameters', ...items, '--query', 'properties.outputs', '-o', 'json'];
}
function ensureTooling(dryRun) { for (const tool of ['az', 'node', 'npm', 'zip']) command(tool, ['--version'], { dryRun }); }
function deployFunction(resourceGroup, functionName, artifact, storageAccountName, location, dryRun) {
  // Flex Consumption accepts OneDeploy only. Stage the package privately and
  // pass its short-lived read URL through a parameter file so it never appears
  // in shell history or process listings.
  const container = 'ariat-onedeploy'; const blob = `${functionName}/released-package.zip`;
  if (dryRun) {
    process.stdout.write(`[dry-run] stage ${artifact} as ${container}/${blob} and invoke OneDeploy for ${functionName}\n`);
    return;
  }
  command('az', ['storage', 'container', 'create', '--account-name', storageAccountName, '--name', container, '--auth-mode', 'login']);
  command('az', ['storage', 'blob', 'upload', '--account-name', storageAccountName, '--container-name', container, '--name', blob, '--file', artifact, '--overwrite', '--content-type', 'application/zip', '--auth-mode', 'login']);
  const expiry = new Date(Date.now() + (60 * 60 * 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const packageUri = command('az', ['storage', 'blob', 'generate-sas', '--account-name', storageAccountName, '--container-name', container, '--name', blob, '--permissions', 'r', '--expiry', expiry, '--https-only', '--as-user', '--auth-mode', 'login', '--full-uri', '-o', 'tsv']);
  const parameterFile = join(mkdtempSync(join(tmpdir(), 'ariat-onedeploy-')), 'parameters.json');
  writeFileSync(parameterFile, `${JSON.stringify({ $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#', contentVersion: '1.0.0.0', parameters: { functionName: { value: functionName }, location: { value: location }, packageUri: { value: packageUri } } })}\n`, { mode: 0o600 });
  try {
    command('az', ['deployment', 'group', 'create', '--name', `onedeploy-${functionName}-${Date.now().toString(36)}`, '--resource-group', resourceGroup, '--template-file', 'iac/deploy-function-package.bicep', '--parameters', `@${parameterFile}`]);
  } finally {
    rmSync(parameterFile, { force: true });
    command('az', ['storage', 'blob', 'delete', '--account-name', storageAccountName, '--container-name', container, '--name', blob, '--auth-mode', 'login']);
  }
}
function bootstrapPolicy(configName, dryRun) {
  const documents = [
    ['ariat:broker:role-map', '{}'],
    ['ariat:broker:connection-grants', '{"version":1,"connections":[]}'],
    ['ariat:broker:vendor-profiles', '{"version":1,"vendors":[]}'],
    ['ariat:broker:principal-profiles', '{"version":1,"principals":[]}'],
  ];
  for (const [key, value] of documents) {
    let last;
    for (let attempt = 1; attempt <= 18; attempt += 1) {
      try { command('az', ['appconfig', 'kv', 'set', '--name', configName, '--key', key, '--value', value, '--content-type', 'application/json', '--auth-mode', 'login', '--yes'], { dryRun }); last = null; break; } catch (error) { last = error; if (dryRun) break; process.stdout.write(`Waiting for App Configuration RBAC (${attempt}/18)…\n`); spawnSync('sleep', ['5'], { stdio: 'ignore' }); }
    }
    if (last) throw last;
  }
}
function doctor(input, dryRun) {
  ensureTooling(dryRun);
  if (input.subscriptionId) command('az', ['account', 'set', '--subscription', input.subscriptionId], { dryRun });
  const account = command('az', ['account', 'show', '-o', 'json'], { json: true, dryRun });
  for (const provider of ['Microsoft.Web', 'Microsoft.Storage', 'Microsoft.KeyVault', 'Microsoft.AppConfiguration', 'Microsoft.Network', 'Microsoft.Insights']) command('az', ['provider', 'show', '--namespace', provider, '--query', 'registrationState', '-o', 'tsv'], { dryRun });
  process.stdout.write(`${dryRun ? 'Dry-run ' : ''}preflight passed for subscription ${account.name || account.id || '<selected>'}.\n`);
  return account;
}
function deploy(input, dryRun) {
  const account = doctor(input, dryRun); const name = names(input); const subscriptionId = input.subscriptionId || account.id;
  const deployer = dryRun ? { id: '<signed-in-user-object-id>' } : command('az', ['ad', 'signed-in-user', 'show', '-o', 'json'], { json: true });
  const tags = Object.entries(input.tags || {}).map(([k, v]) => `${k}=${v}`);
  command('az', ['group', 'create', '--name', input.resourceGroup, '--location', input.location, ...(tags.length ? ['--tags', ...tags] : [])], { dryRun });
  command('az', deploymentArgs(input.resourceGroup, 'deploy/infra/network.bicep', { location: input.location, vnetName: name.vnet, addressPrefixes: input.network.addressPrefixes, tags: input.tags || {} }), { dryRun });
  const brokerIdentity = createApp(`Tessera Broker ${input.environment}`, [], [], dryRun);
  const adminBase = `https://${name.admin}.azurewebsites.net`;
  const adminIdentity = createApp(`Tessera Admin ${input.environment}`, [role('Tessera.Operator', ['User'])], [`${adminBase}/.auth/login/aad/callback`], dryRun);
  // OneDeploy must complete before a broker Private Endpoint is attached.
  const foundationParameters = { namingSuffix: name.suffix, location: input.location, existingVnetName: name.vnet, existingVnetResourceGroup: input.resourceGroup, vnetIntegrationSubnetCidr: input.network.integrationSubnetCidr, privateEndpointSubnetCidr: input.network.privateEndpointSubnetCidr, onPremIngressCidr: input.operatorAllowedCidrs[0], vpnClientCidr: input.operatorAllowedCidrs[0], blockedSourceCidrs: [], deployPrivateEndpoint: false, publicNetworkAccess: 'Disabled', brokerHostname: `${name.broker}.azurewebsites.net`, brokerSettings: { ROLE_SECRET_MAP: '{}' } };
  const foundation = command('az', deploymentArgs(input.resourceGroup, 'iac/foundation.bicep', foundationParameters), { json: true, dryRun });
  const f = dryRun ? { functionName: name.broker, storageAccountName: '<from-foundation>', keyVaultName: '<from-foundation>', appInsightsConnectionString: '<from-foundation>', identityPrincipalId: '<from-foundation>', functionDefaultHostname: `${name.broker}.azurewebsites.net` } : Object.fromEntries(Object.entries(foundation).map(([k, v]) => [k, v.value]));
  const tenantId = account.tenantId || '<selected-tenant-id>';
  command('az', deploymentArgs(input.resourceGroup, 'iac/auth.bicep', { functionName: f.functionName || name.broker, brokerClientId: brokerIdentity.appId, brokerIssuer: `https://login.microsoftonline.com/${tenantId}/v2.0`, brokerAppIdUri: `api://${brokerIdentity.appId}`, allowedApplications: [], authMode: 'entra' }), { dryRun });
  const management = command('az', deploymentArgs(input.resourceGroup, 'iac/management.bicep', { namingSuffix: name.suffix, location: input.location, vnetName: name.vnet, integrationSubnetCidr: input.network.adminIntegrationSubnetCidr, privateEndpointSubnetName: `ariat-${name.suffix}-pe-subnet`, adminPublicNetworkAccess: 'Enabled', appConfigPublicNetworkAccess: 'Enabled', operatorAllowedCidrs: input.operatorAllowedCidrs, storageAccountName: f.storageAccountName, keyVaultName: f.keyVaultName, appInsightsConnectionString: f.appInsightsConnectionString, brokerPrincipalId: f.identityPrincipalId, deployerPrincipalId: deployer.id }), { json: true, dryRun });
  const m = dryRun ? { adminFunctionName: name.admin, adminHostname: `${name.admin}.azurewebsites.net`, appConfigEndpoint: '<from-management>' } : Object.fromEntries(Object.entries(management).map(([k, v]) => [k, v.value]));
  bootstrapPolicy(m.appConfigName || '<from-management>', dryRun);
  // `sites/config/appsettings` is a replace document in ARM. Use the CLI's
  // merge operation so policy settings never erase Functions host storage
  // settings required by Flex Consumption.
  command('az', ['functionapp', 'config', 'appsettings', 'set', '--resource-group', input.resourceGroup, '--name', f.functionName || name.broker, '--settings', `APP_CONFIG_ENDPOINT=${m.appConfigEndpoint}`, 'POLICY_CACHE_TTL_SECONDS=15'], { dryRun });
  command('az', deploymentArgs(input.resourceGroup, 'iac/management-auth.bicep', { functionName: m.adminFunctionName || name.admin, operatorClientId: adminIdentity.appId, operatorIssuer: `https://login.microsoftonline.com/${tenantId}/v2.0`, operatorAppIdUri: `api://${adminIdentity.appId}`, allowedApplications: [] }), { dryRun });
  command('az', ['appconfig', 'update', '--name', m.appConfigName || `<from-management>`, '--resource-group', input.resourceGroup, '--public-network', 'Disabled'], { dryRun });
  if (!dryRun) {
    const operatorRoleId = (graph('GET', `/applications/${adminIdentity.id}`, null, false).appRoles || []).find((item) => item.value === 'Tessera.Operator')?.id;
    try { graph('POST', `/servicePrincipals/${adminIdentity.servicePrincipalId}/appRoleAssignedTo`, { principalId: deployer.id, resourceId: adminIdentity.servicePrincipalId, appRoleId: operatorRoleId }, false); } catch (error) {
      if (!/already exists|Request_BadRequest/i.test(String(error.message))) throw error;
    }
  }
  const brokerZip = packageFunction('function-node', dryRun); const adminZip = packageFunction('admin-function', dryRun);
  // The deployment transport needs short-lived public access to the Function
  // control plane and its deployment storage.  Always restore both afterwards.
  let storageOpened = false;
  try {
    command('az', ['storage', 'account', 'update', '--resource-group', input.resourceGroup, '--name', f.storageAccountName, '--public-network-access', 'Enabled', '--default-action', 'Allow'], { dryRun });
    storageOpened = true;
    command('az', ['functionapp', 'update', '--resource-group', input.resourceGroup, '--name', f.functionName || name.broker, '--set', 'publicNetworkAccess=Enabled'], { dryRun });
    if (!dryRun) spawnSync('sleep', ['20'], { stdio: 'ignore' });
    deployFunction(input.resourceGroup, f.functionName || name.broker, brokerZip, f.storageAccountName, input.location, dryRun);
    deployFunction(input.resourceGroup, m.adminFunctionName || name.admin, adminZip, f.storageAccountName, input.location, dryRun);
  } finally {
    command('az', ['functionapp', 'update', '--resource-group', input.resourceGroup, '--name', f.functionName || name.broker, '--set', 'publicNetworkAccess=Disabled'], { dryRun });
    if (storageOpened) command('az', ['storage', 'account', 'update', '--resource-group', input.resourceGroup, '--name', f.storageAccountName, '--public-network-access', 'Disabled', '--default-action', 'Deny'], { dryRun });
  }
  command('az', deploymentArgs(input.resourceGroup, 'iac/foundation.bicep', { ...foundationParameters, deployPrivateEndpoint: true }), { dryRun });
  const output = { subscriptionId, broker: { appId: brokerIdentity.appId, principalId: f.identityPrincipalId, functionName: f.functionName || name.broker, url: `https://${f.functionDefaultHostname || `${name.broker}.azurewebsites.net`}` }, admin: { appId: adminIdentity.appId, functionName: m.adminFunctionName || name.admin, url: `https://${m.adminHostname || `${name.admin}.azurewebsites.net`}/console` }, appConfigEndpoint: m.appConfigEndpoint, keyVaultName: f.keyVaultName, storageAccountName: f.storageAccountName };
  if (dryRun) { process.stdout.write(`Dry-run complete; no state file was written.\n${JSON.stringify(output, null, 2)}\n`); return; }
  const state = writeState(input, output); process.stdout.write(`Deployment state written to ${state}.\n`);
}
function state(file) { if (!file || !existsSync(file)) fail('--state must reference a generated Tessera state file'); return JSON.parse(readFileSync(file, 'utf8')); }
function api(stateValue, path, method, body) { const token = command('az', ['account', 'get-access-token', '--scope', `api://${stateValue.admin.appId}/user_impersonation`, '--query', 'accessToken', '-o', 'tsv']); const response = spawnSync('curl', ['--fail-with-body', '--silent', '--show-error', '-X', method, '-H', `Authorization: Bearer ${token}`, '-H', 'content-type: application/json', ...(body ? ['--data', JSON.stringify(body)] : []), `${stateValue.admin.url.replace(/\/console$/, '')}/api/${path}`], { encoding: 'utf8' }); if (response.status !== 0) fail(response.stderr || response.stdout || 'management API request failed'); return JSON.parse(response.stdout); }
function manage(positional, options) {
  const current = state(options.state); const [area, action] = positional;
  if (area === 'key' && action === 'plan') { const vendor = options.vendor; const name = options.name; if (!vendor || !name) fail('key plan requires --vendor and --name'); const key = `${vendor}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`; process.stdout.write(`${JSON.stringify({ vendor, displayName: name, credentialType: options.type || 'api_key', role: `VendorApi.${vendor.replace(/(^|-)[a-z]/g, (part) => part.replace('-', '').toUpperCase())}.Invoke`, keyVaultSecretName: key }, null, 2)}\n`); return; }
  if (area === 'vendor' && action === 'add') { if (!options.id || !options.name || !options.auth) fail('vendor add requires --id, --name, and --auth'); process.stdout.write(`${JSON.stringify(api(current, 'vendors', 'POST', { id: options.id, displayName: options.name, authType: options.auth }), null, 2)}\n`); return; }
  if (area === 'vendor' && action === 'provision') {
    if (!options.id || !options.name || !options.auth || !options['base-url'] || !options['secret-file']) fail('vendor provision requires --id, --name, --auth, --base-url, and --secret-file');
    if (!existsSync(options['secret-file'])) fail('--secret-file must reference a local file; the value is never accepted on the command line');
    const vendorId = options.id.toLowerCase(); if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(vendorId) || !/^https:\/\//.test(options['base-url'])) fail('vendor id or base URL is invalid');
    const roleValue = `VendorApi.${vendorId.replace(/(^|-)[a-z]/g, (part) => part.replace('-', '').toUpperCase())}.Invoke`;
    const app = graph('GET', `/applications(appId='${current.broker.appId}')`, null, false); const roles = Array.isArray(app.appRoles) ? app.appRoles : [];
    if (!roles.some((item) => item.value === roleValue)) graph('PATCH', `/applications/${app.id}`, { appRoles: [...roles, role(roleValue, ['User', 'Application'])] }, false);
    const secretName = `ariat-${vendorId}`;
    const secretId = command('az', ['keyvault', 'secret', 'set', '--vault-name', current.keyVaultName, '--name', secretName, '--file', options['secret-file'], '--encoding', 'utf-8', '--query', 'id', '-o', 'tsv']);
    command('az', ['role', 'assignment', 'create', '--role', 'Key Vault Secrets User', '--assignee-object-id', current.broker.principalId, '--assignee-principal-type', 'ServicePrincipal', '--scope', secretId]);
    const vendor = api(current, 'vendors', 'POST', { id: vendorId, displayName: options.name, authType: options.auth, baseUrl: options['base-url'] });
    const connection = api(current, 'connections', 'POST', { role: roleValue, secret: secretName, displayName: options.name, vendor: vendorId, baseUrl: options['base-url'], inject: options.auth === 'api-key' ? 'header' : options.auth });
    process.stdout.write(`${JSON.stringify({ vendor: vendor.vendor, connection: connection.connection, role: roleValue, credentialStored: true }, null, 2)}\n`); return;
  }
  if (area === 'principal' && action === 'set') { if (!options.id || !options.name) fail('principal set requires --id and --name'); process.stdout.write(`${JSON.stringify(api(current, 'principals', 'POST', { id: options.id, displayName: options.name }), null, 2)}\n`); return; }
  if (area === 'grant') { if (!options.connection || !options.kind || !options.subject) fail('grant requires --connection, --kind, and --subject'); process.stdout.write(`${JSON.stringify(api(current, `connections/${encodeURIComponent(options.connection)}/grants`, 'POST', { kind: options.kind, subject: options.subject }), null, 2)}\n`); return; }
  fail(usage);
}
export async function main(argv) {
  const { positional, options } = parse(argv); if (!positional.length || options.help) { process.stdout.write(`${usage}\n`); return; }
  const [commandName] = positional;
  if (commandName === 'doctor') return doctor(config(options.config), options.dryRun);
  if (commandName === 'deploy') return deploy(config(options.config), options.dryRun);
  if (commandName === 'outputs') { process.stdout.write(`${JSON.stringify(state(options.state), null, 2)}\n`); return; }
  return manage(positional, options);
}
