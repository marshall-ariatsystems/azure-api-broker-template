// Behavioral tests for the oauth2cc token lifecycle + reactive recovery (FR-3) in broker.js.
// Mocks the three @azure/* modules, loads the REAL handler, and drives it with a scripted fetch.
// Run:  node function-node/test/oauth-recovery.test.js
const assert = require('assert');
const Module = require('module');
const path = require('path');

const BROKER = path.join(__dirname, '..', 'src', 'broker.js');

process.env.KEYVAULT_URI = 'https://kv.vault.azure.net/';
process.env.ROLE_SECRET_MAP = JSON.stringify({
  'VendorApi.HCSS.Invoke': {
    secret: 'hcss-client', baseUrl: 'https://api.hcssapps.com',
    inject: 'oauth2cc', tokenUrl: 'https://token.example/connect', scope: 'x',
  },
});
// Rate limiter env settings (required for quota enforcement)
process.env.QUOTA_CALLER_PER_MIN = '1000'; // high limit for tests
process.env.QUOTA_KEY_PER_MIN = '1000';
process.env.RATE_LIMIT_TABLE_NAME = 'brokerRateLimits';
process.env.RATE_LIMIT_FAIL_MODE = 'open'; // fail-open for tests (no Table Storage available)
process.env.RATE_LIMIT_STORAGE_ACCOUNT = 'teststorage';
process.env.CONNECTION_GRANTS_JSON = JSON.stringify({ version: 1, connections: [{ id: 'azure:hcss', subjects: ['user:oid-1'] }] });

function loadBroker() {
  delete require.cache[require.resolve(BROKER)];
  const handlers = {};
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '@azure/functions') return { app: { http: (n, o) => { handlers[n] = o.handler; } } };
    if (request === '@azure/identity') return { DefaultAzureCredential: class {} };
    if (request === '@azure/keyvault-secrets') {
      return { SecretClient: class { async getSecret() { return { value: JSON.stringify({ client_id: 'cid', client_secret: 'sec' }) }; } } };
    }
    if (request === '@azure/data-tables') {
      return {
        TableClient: class {
          async createTable() {}
          async createEntity() {}
          async getEntity() { throw { statusCode: 404, code: 'ResourceNotFound' }; }
          async updateEntity() {}
        },
      };
    }
    return orig.call(this, request, ...rest);
  };
  try { require(BROKER); } finally { Module._load = orig; }
  return handlers;
}

function fakeReq({ method = 'GET', p = 'heavyjob/api/v1/businessUnits' } = {}) {
  const principal = Buffer.from(JSON.stringify({
    claims: [{ typ: 'roles', val: 'VendorApi.HCSS.Invoke' }, { typ: 'oid', val: 'oid-1' }],
  })).toString('base64');
  return {
    method,
    params: { path: p },
    query: new URLSearchParams(),
    headers: new Map([['x-ms-client-principal', principal]]),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
const ctx = { log() {}, error() {} };

let mint, vendorCalls, vendorStatus;
function installFetch() {
  mint = 0; vendorCalls = 0;
  global.fetch = async (url) => {
    if (String(url).startsWith('https://token')) {
      mint++;
      return { ok: true, status: 200, json: async () => ({ access_token: 'T' + mint, expires_in: 3600 }) };
    }
    const status = vendorStatus(vendorCalls++);
    return {
      status,
      arrayBuffer: async () => Buffer.from(JSON.stringify({ value: [] })),
      headers: new Map([['content-type', 'application/json']]),
    };
  };
}

(async () => {
  // 1. happy path + cache-hit: token minted once across two calls.
  {
    const h = loadBroker().broker; installFetch(); vendorStatus = () => 200;
    assert.strictEqual((await h(fakeReq(), ctx)).status, 200);
    assert.strictEqual((await h(fakeReq(), ctx)).status, 200);
    assert.strictEqual(mint, 1, 'token minted once (2nd served from cache)');
    assert.strictEqual(vendorCalls, 2);
    console.log('PASS  cache-hit: 1 mint across 2 calls');
  }
  // 2. 401 -> re-mint -> retry -> 200.
  {
    const h = loadBroker().broker; installFetch(); vendorStatus = (n) => (n === 0 ? 401 : 200);
    assert.strictEqual((await h(fakeReq(), ctx)).status, 200, 'recovered');
    assert.strictEqual(mint, 2, 're-minted after 401');
    assert.strictEqual(vendorCalls, 2, 'retried once');
    console.log('PASS  401-recovery: re-mint + retry -> 200');
  }
  // 3. persistent 401 -> exactly one re-mint, returns 401 (no infinite loop).
  {
    const h = loadBroker().broker; installFetch(); vendorStatus = () => 401;
    assert.strictEqual((await h(fakeReq(), ctx)).status, 401, 'gives up with 401');
    assert.strictEqual(mint, 2, 're-minted exactly once');
    assert.strictEqual(vendorCalls, 2, 'exactly one retry');
    console.log('PASS  401-persistent: one re-mint, returns 401');
  }
  // 4. transient 503 on GET -> one retry -> 200.
  {
    const h = loadBroker().broker; installFetch(); vendorStatus = (n) => (n === 0 ? 503 : 200);
    assert.strictEqual((await h(fakeReq(), ctx)).status, 200, '5xx retry recovered');
    assert.strictEqual(vendorCalls, 2, 'one retry');
    console.log('PASS  5xx-retry: 503 GET retried -> 200');
  }
  // 5. POST 503 -> NOT retried (non-idempotent).
  {
    const h = loadBroker().broker; installFetch(); vendorStatus = () => 503;
    assert.strictEqual((await h(fakeReq({ method: 'POST' }), ctx)).status, 503, 'passthrough');
    assert.strictEqual(vendorCalls, 1, 'no retry on non-idempotent');
    console.log('PASS  5xx-no-retry: POST 503 not retried');
  }
  console.log('\nALL PASS');
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
