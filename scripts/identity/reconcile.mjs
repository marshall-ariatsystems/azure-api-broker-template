#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fail(message) { throw new Error(message); }
function run(command, args, { json = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 && !allowFailure) fail((result.stderr || result.stdout || `${command} failed`).trim());
  if (result.status !== 0) return null;
  return json ? JSON.parse(result.stdout || 'null') : result.stdout.trim();
}
function env(name, fallback = '') {
  return process.env[name] || run('azd', ['env', 'get-value', name], { allowFailure: true }) || fallback;
}
function setEnv(name, value) { run('azd', ['env', 'set', name, value]); }
function uniqueNameFor(kind) {
  const environment = env('AZURE_ENV_NAME'); const resourceGroup = env('AZURE_RESOURCE_GROUP');
  if (!environment || !resourceGroup) fail('AZURE_ENV_NAME and AZURE_RESOURCE_GROUP are required; run this through azd');
  return `api-broker-${resourceGroup}-${environment}-${kind}`;
}
function findApp(displayName) {
  const values = run('az', ['ad', 'app', 'list', '--display-name', displayName, '--query', `[?displayName=='${displayName.replaceAll("'", "''")}']`, '-o', 'json'], { json: true });
  if (values.length > 1) fail(`multiple Entra applications are named ${displayName}`);
  return values[0] || null;
}
function ensureApp(displayName, roles = []) {
  let app = findApp(displayName);
  if (!app) {
    app = run('az', ['ad', 'app', 'create', '--display-name', displayName, '--sign-in-audience', 'AzureADMyOrg', '--app-roles', JSON.stringify(roles), '-o', 'json'], { json: true });
  }
  const uniqueName = uniqueNameFor(displayName.includes('Admin') ? 'admin' : 'broker');
  if (app.uniqueName !== uniqueName) {
    patchApplication(app.id, { uniqueName });
    app = run('az', ['ad', 'app', 'show', '--id', app.appId, '-o', 'json'], { json: true });
  }
  const principal = run('az', ['ad', 'sp', 'show', '--id', app.appId, '-o', 'json'], { json: true, allowFailure: true }) || run('az', ['ad', 'sp', 'create', '--id', app.appId, '-o', 'json'], { json: true });
  return { ...app, servicePrincipalId: principal.id };
}
function operatorRole() {
  return { allowedMemberTypes: ['User'], description: 'Administer API broker connections, grants, branding, and write-only credential rotation.', displayName: 'Broker operator', id: randomUUID(), isEnabled: true, origin: 'Application', value: 'Broker.Operator' };
}
function patchApplication(objectId, body) {
  run('az', ['rest', '--method', 'PATCH', '--url', `https://graph.microsoft.com/v1.0/applications/${objectId}`, '--headers', 'content-type=application/json', '--body', JSON.stringify(body)]);
}
function prepare() {
  const environment = env('AZURE_ENV_NAME'); if (!environment) fail('AZURE_ENV_NAME is required; run this through azd');
  const broker = ensureApp(`Azure API Broker ${environment}`);
  let admin = ensureApp(`Azure API Broker Admin ${environment}`, [operatorRole()]);
  if (!(admin.appRoles || []).some((role) => role.value === 'Broker.Operator')) {
    patchApplication(admin.id, { appRoles: [...(admin.appRoles || []), operatorRole()] });
    admin = findApp(`Azure API Broker Admin ${environment}`);
  }
  const role = (admin.appRoles || []).find((item) => item.value === 'Broker.Operator');
  if (!role) fail('Broker.Operator role is missing after reconciliation');
  setEnv('BROKER_CLIENT_ID', broker.appId); setEnv('BROKER_APPLICATION_OBJECT_ID', broker.id); setEnv('BROKER_SERVICE_PRINCIPAL_ID', broker.servicePrincipalId);
  setEnv('ADMIN_CLIENT_ID', admin.appId); setEnv('ADMIN_APPLICATION_OBJECT_ID', admin.id); setEnv('ADMIN_SERVICE_PRINCIPAL_ID', admin.servicePrincipalId);
  setEnv('OPERATOR_OBJECT_ID', run('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv']));
  setEnv('OPERATOR_ROLE_ID', role.id);
  process.stdout.write('Entra applications reconciled without client credentials.\n');
}
function finalize() {
  const adminName = env('AZURE_ADMIN_NAME'); const adminObjectId = env('ADMIN_APPLICATION_OBJECT_ID'); const adminSpId = env('ADMIN_SERVICE_PRINCIPAL_ID');
  if (!adminName || !adminObjectId || !adminSpId) fail('provisioning outputs or identity state are missing');
  patchApplication(adminObjectId, { web: { redirectUris: [`https://${adminName}.azurewebsites.net/.auth/login/aad/callback`], implicitGrantSettings: { enableIdTokenIssuance: true, enableAccessTokenIssuance: false } } });
  const app = run('az', ['ad', 'app', 'show', '--id', env('ADMIN_CLIENT_ID'), '-o', 'json'], { json: true });
  const role = (app.appRoles || []).find((item) => item.value === 'Broker.Operator'); if (!role) fail('Broker.Operator role is missing');
  const user = run('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv']);
  const body = { principalId: user, resourceId: adminSpId, appRoleId: role.id };
  run('az', ['rest', '--method', 'POST', '--url', `https://graph.microsoft.com/v1.0/servicePrincipals/${adminSpId}/appRoleAssignedTo`, '--headers', 'content-type=application/json', '--body', JSON.stringify(body)], { allowFailure: true });
  process.stdout.write('Admin redirect and initial operator assignment reconciled.\n');
}

try {
  if (process.argv[2] === 'prepare') prepare();
  else if (process.argv[2] === 'finalize') finalize();
  else fail('usage: reconcile.mjs prepare|finalize');
} catch (error) { process.stderr.write(`identity: ${error.message}\n`); process.exitCode = 1; }
