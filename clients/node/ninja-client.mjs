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

import { loadBrokerConfig } from './broker-preflight.mjs';
import { requestWithRetry } from './broker-retry.mjs';

let credential = null;
let cachedEntra = null; // { token, exp }

async function entraToken(scope) {
  const now = Date.now();
  if (cachedEntra && cachedEntra.exp > now) return cachedEntra.token;
  if (!credential) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    credential = new DefaultAzureCredential();
  }
  const t = await credential.getToken(scope);
  cachedEntra = { token: t.token, exp: t.expiresOnTimestamp - 120_000 };
  return t.token;
}

const CREDENTIAL_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'apikey', 'api_key',
  'key', 'access_token', 'token', 'subscription-key', 'x-api-key-id', 'x-api-secret',
  'x-key-id', 'x-secret', 'client_id', 'client_secret',
]);

function safeCallerHeaders(headers) {
  const normalized = new Headers(headers || {});
  for (const name of normalized.keys()) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      throw new TypeError(`credential-shaped caller header is not allowed: ${name}`);
    }
  }
  return normalized;
}

function retryPolicy(init) {
  return {
    maxRetries: Number.isSafeInteger(init.maxRetries) ? Math.max(0, Math.min(init.maxRetries, 2)) : 2,
    jitterCeilingMs: 250,
    defaultRetryAfterSeconds: 1,
  };
}

/**
 * Build a client whose public request and preflight paths both use validated broker config.
 * Injection points are intentionally provided for integration tests and alternate fetch runtimes.
 */
export function createNinjaClient({ config = loadBrokerConfig(), acquireToken, fetchImpl = fetch, clock, jitter } = {}) {
  config = loadBrokerConfig({ BROKER_BASE: config.base, BROKER_SCOPE: config.scope });
  const token = acquireToken || (() => entraToken(config.scope));
  const waitClock = clock || { sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };
  const randomJitter = jitter || { next: (ceiling) => Math.floor(Math.random() * (ceiling + 1)) };

  async function authenticatedFetch(url, init = {}) {
    const { headers, ...rest } = init;
    const safeHeaders = safeCallerHeaders(headers);
    safeHeaders.set('authorization', `Bearer ${await token()}`);
    return fetchImpl(url, { ...rest, headers: safeHeaders });
  }

  async function preflight(routeSlug) {
    if (typeof routeSlug !== 'string' || !/^[a-z0-9-]{1,64}$/.test(routeSlug)) {
      throw new TypeError('routeSlug must be a lowercase route slug');
    }
    const response = await authenticatedFetch(`${config.base}/preflight/${routeSlug}`, { method: 'GET', headers: { accept: 'application/json' } });
    return { status: response.status, correlationId: response.headers.get('x-correlation-id') ?? null };
  }

  async function ninja(path, init = {}) {
    if (typeof path !== 'string' || !path) throw new TypeError('path is required');
    const { json, maxRetries, ...requestInit } = init;
    const method = (requestInit.method || 'GET').toUpperCase();
    const request = {
      ...requestInit,
      method,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      headers: {
        accept: 'application/json',
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(requestInit.headers || {}),
      },
    };
    let response;
    await requestWithRetry({
      doFetch: async () => {
        response = await authenticatedFetch(`${config.base}${path.startsWith('/') ? path : `/${path}`}`, request);
        return response;
      },
      request: { idempotent: method === 'GET' || method === 'HEAD' },
      policy: retryPolicy({ maxRetries }),
      clock: waitClock,
      jitter: randomJitter,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`broker ${response.status} for ${path}: ${detail.slice(0, 500)}`);
    }
    const ct = response.headers.get('content-type') || '';
    return ct.includes('json') ? response.json() : response.text();
  }

  return Object.freeze({ ninja, preflight });
}

/**
 * Call a vendor API path through the broker.
 * @param {string} path e.g. '/v2/organizations'
 * @param {object} [init] fetch init; use init.json for a JSON body convenience.
 * @returns parsed JSON (or text when the response isn't JSON)
 */
export async function ninja(path, init = {}) {
  return createNinjaClient().ninja(path, init);
}

/** Run the authenticated, no-side-effect broker authorization preflight. */
export async function preflight(routeSlug) {
  return createNinjaClient().preflight(routeSlug);
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
