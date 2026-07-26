// Verifies secretless managed-identity injection using the real broker handler.
const assert = require('assert');
const Module = require('module');
const path = require('path');

const BROKER = path.join(__dirname, '..', 'src', 'broker.js');
process.env.KEYVAULT_URI = 'https://kv.vault.azure.net/';
process.env.ROLE_SECRET_MAP = JSON.stringify({
  'VendorApi.Graph.Invoke': {
    baseUrl: 'https://graph.microsoft.com/v1.0', inject: 'entra', scope: 'https://graph.microsoft.com/.default', route: 'graph',
  },
});
process.env.QUOTA_CALLER_PER_MIN = '1000';
process.env.QUOTA_KEY_PER_MIN = '1000';
process.env.RATE_LIMIT_FAIL_MODE = 'open';
process.env.RATE_LIMIT_STORAGE_ACCOUNT = 'teststorage';
process.env.CONNECTION_GRANTS_JSON = JSON.stringify({ version: 1, connections: [{ id: 'azure:graph', subjects: ['user:graph-caller'] }] });

let requestedScopes = [];
function loadBroker() {
  delete require.cache[require.resolve(BROKER)];
  const handlers = {};
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '@azure/functions') return { app: { http: (name, options) => { handlers[name] = options.handler; } } };
    if (request === '@azure/identity') return { DefaultAzureCredential: class { async getToken(scope) { requestedScopes.push(scope); return { token: 'graph-workload-token' }; } } };
    if (request === '@azure/keyvault-secrets') return { SecretClient: class { async getSecret() { throw new Error('Graph must not read Key Vault'); } } };
    if (request === '@azure/data-tables') return { TableClient: class { async createTable() {} async createEntity() {} async getEntity() { throw { statusCode: 404, code: 'ResourceNotFound' }; } async updateEntity() {} } };
    return originalLoad.call(this, request, ...rest);
  };
  try { require(BROKER); } finally { Module._load = originalLoad; }
  return handlers.broker;
}

(async () => {
  const handler = loadBroker();
  const principal = Buffer.from(JSON.stringify({ claims: [{ typ: 'roles', val: 'VendorApi.Graph.Invoke' }, { typ: 'oid', val: 'graph-caller' }] })).toString('base64');
  let sent;
  global.fetch = async (url, options) => {
    sent = { url, headers: options.headers };
    return { status: 200, arrayBuffer: async () => Buffer.from('{}'), headers: new Map([['content-type', 'application/json']]) };
  };
  const response = await handler({ method: 'GET', params: { path: 'me' }, query: new URLSearchParams(), headers: new Map([['x-ms-client-principal', principal]]), arrayBuffer: async () => new ArrayBuffer(0) }, { log() {}, error() {} });
  assert.equal(response.status, 200);
  assert.deepEqual(requestedScopes, ['https://graph.microsoft.com/.default']);
  assert.equal(sent.url, 'https://graph.microsoft.com/v1.0/me');
  assert.equal(sent.headers.authorization, 'Bearer graph-workload-token');
  console.log('PASS  Graph uses managed identity without a Key Vault secret');
})().catch((error) => { console.error('FAIL:', error.stack || error.message); process.exit(1); });
