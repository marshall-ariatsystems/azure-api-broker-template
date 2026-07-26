// broker-bridge.mjs — a drop-in local proxy that lets EXISTING apps use the key broker with a
// one-line config change and ZERO vendor credentials on the box.
//
// The point (identity-governed keys): instead of every app holding a vendor API key in its .env,
// the key lives in the broker's Key Vault and access is governed by Entra app-role assignments in
// ONE tenant. This bridge is the client half: it authenticates as the caller's Entra identity
// (via DefaultAzureCredential — your `az login` session, an SP, or a managed identity), attaches
// the token, and forwards to the broker. The broker injects the real key server-side. The vendor
// key and any vendor token never reach this machine.
//
// What an app has to change (that's it):
//   - const OPENAI_BASE_URL = 'https://api.openrouter.ai/api/v1'      // before
//   + const OPENAI_BASE_URL = 'http://127.0.0.1:8079/openrouter/v1'   // after: point at the bridge
//   - delete the API key from the app's env entirely.
// The first path segment names the vendor (its broker slug, e.g. `openrouter`, `graph`, `stripe`,
// `ninjaone`); everything after it is the vendor's own path. Requires the broker to have that
// vendor onboarded (KV secret + app-role + ROLE_SECRET_MAP) and this identity assigned the role.
// Multi-vendor from one identity requires MULTI_ROLE_VENDOR_ROUTING=true on the broker.
//
// Config (env):
//   BROKER_BASE   https://<function-app>.azurewebsites.net/api/broker   (required)
//   BROKER_SCOPE  api://<broker-client-id>/.default                     (required)
//   BRIDGE_HOST   default 127.0.0.1  (loopback only — do NOT bind to 0.0.0.0)
//   BRIDGE_PORT   default 8079
//
// Run: node broker-bridge.mjs   (or: npm start)

import http from 'node:http';
import { compatibilityEnvironment, initializeBridge, loadBridgeConfig, parseCli, usage } from './cli.mjs';
import { runApplication } from './launcher.mjs';
import { brokerRequestHeaders, HOP_BY_HOP_HEADERS } from './request-policy.mjs';
import { routeBrokerPath } from './routing.mjs';
import { BRIDGE_VERSION } from './version.mjs';

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.error) {
    console.error(`${cli.error}\n\n${usage()}`);
    process.exit(2);
  }
  if (cli.command === 'help') {
    console.log(usage());
    process.exit(0);
  }
  if (cli.command === 'version') {
    console.log(`broker-bridge ${BRIDGE_VERSION}`);
    return;
  }
  if (cli.command === 'init') {
    try {
      const result = await initializeBridge(cli);
      console.log(`Created ${result.outputPath}`);
      if (result.dotenv === 'linked') console.log(`Created .env -> ${cli.output} for familiar dotenv workflows.`);
      if (result.dotenv === 'already-linked') console.log('.env already points to broker.env.');
      if (result.dotenv === 'existing-file') console.log('Existing .env was left unchanged. Re-run with --append-dotenv to add a managed Broker Bridge block.');
      if (result.dotenv === 'existing-symlink') console.log('Existing .env symlink was left unchanged.');
      if (result.dotenv === 'not-linked') console.log(`Could not create .env symlink (${result.reason}); use broker.env directly or --append-dotenv with an existing .env.`);
      console.log('Next: fill in BROKER_BASE and BROKER_SCOPE, run `az login`, then start the bridge with `broker-bridge serve`.');
      process.exit(0);
    } catch (error) {
      console.error(`broker-bridge init failed: ${error.message}`);
      process.exit(1);
    }
  }

  if (cli.command === 'run') {
    try {
      const config = await loadBridgeConfig({ config: cli.config });
      const compatibilityEnv = compatibilityEnvironment({ ...config, preset: cli.preset, mappings: cli.mappings });
      const exitCode = await runApplication({
        application: cli.application,
        configPath: cli.config,
        compatibilityEnv,
        host: config.host,
        port: config.port,
      });
      process.exit(exitCode);
    } catch (error) {
      console.error(`broker-bridge run failed: ${error.message}`);
      process.exit(1);
    }
  }

  let runtimeConfig;
  try {
    runtimeConfig = await loadBridgeConfig({ config: cli.config });
  } catch (error) {
    console.error(`broker-bridge configuration error: ${error.message}`);
    process.exit(2);
  }
  const BROKER_BASE = runtimeConfig.brokerBase;
  const BROKER_SCOPE = runtimeConfig.brokerScope;
  const BROKER_VENDOR = runtimeConfig.vendor;
  const BROKER_ROUTING_MODE = runtimeConfig.routingMode;
  const HOST = runtimeConfig.host;
  const PORT = runtimeConfig.port;

  // Dynamic import means `broker-bridge init` and configuration validation work before npm
  // dependencies are installed; serving still requires the Azure Identity package.
  let DefaultAzureCredential;
  try {
    ({ DefaultAzureCredential } = await import('@azure/identity'));
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      // Wait for the piped stderr write so CLI callers receive the remediation message too.
      process.stderr.write('Azure Identity is not installed. Run `npm install` in clients/bridge before serving.\n', () => process.exit(2));
      await new Promise(() => {});
    }
    throw error;
  }

  // Optional public route catalogue. This contains no secret names, broker roles, or injection
  // settings; the broker remains authoritative for authorization and vendor configuration.
  let KNOWN_VENDORS = {};
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    KNOWN_VENDORS = JSON.parse(readFileSync(join(here, 'bridge.config.json'), 'utf8')).vendors || {};
  } catch {
    /* config is optional */
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

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const path = url.pathname.replace(/^\/+/, '');

    // Local, unauthenticated bridge endpoints (never forwarded).
    if (path === '_bridge/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, brokerBase: BROKER_BASE }));
      return;
    }
    if (path === '_bridge/vendors') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ vendors: KNOWN_VENDORS }, null, 2));
      return;
    }

    const vendor = path.split('/')[0] || '';
    if (!vendor) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'path must start with a vendor slug: /<vendor>/<vendor-path>' }));
      return;
    }
    if (BROKER_ROUTING_MODE === 'named' && Object.keys(KNOWN_VENDORS).length && !KNOWN_VENDORS[vendor]) {
      // Soft warning only — still forward (broker is authoritative on what exists).
      console.warn(`[bridge] vendor '${vendor}' not in bridge.config.json — forwarding anyway`);
    }

    let token;
    try {
      token = await entraToken();
    } catch (e) {
      console.error('[bridge] token acquisition failed:', e && e.message ? e.message : e);
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'could not acquire Entra token (is `az login` current?)' }));
      return;
    }

    // Relay to the broker's vendor-named route. Build the URL from the FIXED broker base, then set
    // ONLY the path and query from the caller via the URL setters — which cannot alter the host. No
    // caller input ever reaches the URL authority, so the destination host is broker-only by
    // construction (SSRF-safe: never pass user input as the URL/first-arg to `new URL`).
    let brokerPath;
    try {
      brokerPath = routeBrokerPath(url.pathname, { vendor: BROKER_VENDOR, routingMode: BROKER_ROUTING_MODE });
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    const target = new URL(BROKER_BASE);
    target.pathname = `${target.pathname.replace(/\/+$/, '')}/${brokerPath}`;
    target.search = url.search;
    const outHeaders = brokerRequestHeaders(req.headers, token);

    const method = (req.method || 'GET').toUpperCase();
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      const buf = await readBody(req);
      if (buf.length) body = buf;
    }

    let vresp;
    try {
      vresp = await fetch(target, { method, headers: outHeaders, body });
    } catch (e) {
      console.error('[bridge] broker request failed:', e && e.message ? e.message : e);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'broker request failed' }));
      return;
    }

    const respBuf = Buffer.from(await vresp.arrayBuffer());
    const respHeaders = {};
    vresp.headers.forEach((val, key) => {
      const lk = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lk) || lk === 'content-encoding') return; // fetch already decoded the body
      respHeaders[key] = val;
    });
    res.writeHead(vresp.status, respHeaders);
    res.end(respBuf);
  });

  server.listen(PORT, HOST, () => {
    console.log(`[bridge] listening on http://${HOST}:${PORT}  ->  ${BROKER_BASE}`);
    console.log(`[bridge] ${BROKER_ROUTING_MODE} routing for vendor '${BROKER_VENDOR}'; point the app at http://${HOST}:${PORT}/${BROKER_VENDOR}/`);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
