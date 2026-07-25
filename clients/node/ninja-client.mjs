// ninja-client.mjs — call a vendor API through the key broker with ZERO vendor credentials.
//
// The old pattern this replaces:
//   const CLIENT_ID = env.VENDOR_API_ID;          // <-- vendor secret on every client
//   const CLIENT_SECRET = env.VENDOR_API_SECRET;  // <-- vendor secret on every client
//   ...local OAuth dance against the vendor...
//
// New pattern: the caller proves WHO IT IS to Entra; the broker holds the vendor credential in
// Key Vault, exchanges it server-side (cached) where needed, and proxies the API call. The
// credential and any vendor token never reach this machine.
//
// Configuration (both required):
//   BROKER_BASE   e.g. https://<function-app>.azurewebsites.net/api/broker
//   BROKER_SCOPE  e.g. api://<broker-client-id>/.default
//
// Caller identity — either of:
//   * a signed-in `az login` user            (dev laptops; user must hold a broker app role)
//   * AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET env vars for a service principal
//     with a direct app-role assignment      (services / CI — the prod pattern)
// DefaultAzureCredential resolves both automatically.
//
// Usage as a library:
//   import { ninja } from './ninja-client.mjs';
//   const orgs = await ninja('/v2/organizations');            // GET, parsed JSON
//   const dev  = await ninja('/v2/device/123');
//   await ninja('/v2/webhook', { method: 'PUT', json: {...} });
// Usage as a CLI:
//   node ninja-client.mjs /v2/organizations

import { DefaultAzureCredential } from '@azure/identity';

const BROKER_BASE = (process.env.BROKER_BASE || '').replace(/\/+$/, '');
const BROKER_SCOPE = process.env.BROKER_SCOPE || '';
if (!BROKER_BASE || !BROKER_SCOPE) {
  console.error('BROKER_BASE and BROKER_SCOPE env vars are required.\n' +
    '  BROKER_BASE  = https://<function-app>.azurewebsites.net/api/broker\n' +
    '  BROKER_SCOPE = api://<broker-client-id>/.default');
  process.exit(2);
}

const credential = new DefaultAzureCredential();
let cachedEntra = null; // { token, exp }

async function entraToken() {
  const now = Date.now();
  if (cachedEntra && cachedEntra.exp > now) return cachedEntra.token;
  const t = await credential.getToken(BROKER_SCOPE);
  cachedEntra = { token: t.token, exp: t.expiresOnTimestamp - 120_000 };
  return t.token;
}

/**
 * Call a vendor API path through the broker.
 * @param {string} path e.g. '/v2/organizations'
 * @param {object} [init] fetch init; use init.json for a JSON body convenience.
 * @returns parsed JSON (or text when the response isn't JSON)
 */
export async function ninja(path, init = {}) {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${BROKER_BASE}${path.startsWith('/') ? path : '/' + path}`, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    headers: {
      accept: 'application/json',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
      authorization: `Bearer ${await entraToken()}`,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`broker ${res.status} for ${path}: ${detail.slice(0, 500)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

// CLI mode: node ninja-client.mjs <path> [method] [json-body]
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const [path, method = 'GET', body] = process.argv.slice(2);
  if (!path) {
    console.error('usage: node ninja-client.mjs <path> [method] [json-body]');
    process.exit(2);
  }
  ninja(path, { method, ...(body ? { json: JSON.parse(body) } : {}) })
    .then((r) => console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
