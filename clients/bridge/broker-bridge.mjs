import http from 'node:http';
import { compatibilityEnvironment, parseCli, usage } from './cli.mjs';
import { runApplication } from './launcher.mjs';
import { brokerRequestHeaders, HOP_BY_HOP_HEADERS } from './request-policy.mjs';
import { BRIDGE_VERSION } from './version.mjs';
import { login as publicOidcLogin } from './public-oidc.mjs';
import { clearSession, getAccessToken } from './session.mjs';
import { isCliEntry } from './src/entry-semantics.mjs';
import { pathToFileURL } from 'node:url';

const LOGIN_REQUIRED = 'login required; run broker-bridge login';
const MAX_DISCOVERY_BYTES = 64 * 1024;

function requireLoopback(host) { if (host !== '127.0.0.1') throw new Error('Bridge host must be exactly 127.0.0.1.'); }
function requirePort(port) { if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bridge port must be an integer from 1 through 65535.'); }
function validHttps(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443'); } catch { return false; } }
function validSession(result, now) { return result && typeof result.accessToken === 'string' && result.accessToken.length > 0 && Number.isFinite(result.expiresAt) && result.expiresAt > now ? result.accessToken : null; }
function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); }); }

export async function resolveBrokerDiscovery(brokerDiscoveryUrl, fetchImpl = fetch) {
  if (!validHttps(brokerDiscoveryUrl)) throw new Error('Broker discovery URL must be HTTPS without credentials, fragments, or a non-default port.');
  const response = await fetchImpl(brokerDiscoveryUrl, { redirect: 'error' });
  if (!response?.ok) throw new Error('Broker discovery request failed.');
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_DISCOVERY_BYTES) throw new Error('Broker discovery response exceeds 64 KiB.');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_DISCOVERY_BYTES) throw new Error('Broker discovery response exceeds 64 KiB.');
  let body; try { body = JSON.parse(text); } catch { throw new Error('Broker discovery response must be JSON.'); }
  if (!body || Object.keys(body).length !== 1 || typeof body.brokerBase !== 'string' || !validHttps(body.brokerBase)) throw new Error('Broker discovery response must be exactly { brokerBase }.');
  return body.brokerBase.replace(/\/+$/, '');
}

export function createBridgeRuntime({ brokerDiscoveryUrl, sessionAdapter, fetchImpl = fetch, createServer = http.createServer, now = Date.now, host = '127.0.0.1', port = 8079 }) {
  if (!validHttps(brokerDiscoveryUrl)) throw new Error('Broker discovery URL must be HTTPS.');
  if (!sessionAdapter || typeof sessionAdapter.getValidatedAccessToken !== 'function') throw new Error('sessionAdapter.getValidatedAccessToken is required.');
  if (typeof fetchImpl !== 'function' || typeof createServer !== 'function' || typeof now !== 'function') throw new Error('Runtime dependencies must be functions.');
  requireLoopback(host); requirePort(port);
  let server; let brokerBase; let listening = false;
  const handler = async (req, res) => {
    const localUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = localUrl.pathname.replace(/^\/+/, '');
    if (path === '_bridge/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    if (path === '_bridge/vendors') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ vendors: {} })); return; }
    if (!path) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'path must start with a vendor slug: /<vendor>/<vendor-path>' })); return; }
    let token;
    try { token = validSession(await sessionAdapter.getValidatedAccessToken({ now: now() }), now()); } catch { token = null; }
    if (!token) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end(LOGIN_REQUIRED); return; }
    const target = new URL(brokerBase);
    target.pathname = `${target.pathname.replace(/\/+$/, '')}/${path}`;
    target.search = localUrl.search;
    const method = (req.method || 'GET').toUpperCase();
    let body; if (method !== 'GET' && method !== 'HEAD') { const input = await readBody(req); if (input.length) body = input; }
    let response;
    try { response = await fetchImpl(target, { method, headers: brokerRequestHeaders(req.headers, token), body }); }
    catch { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'broker request failed' })); return; }
    const headers = {}; response.headers.forEach((value, key) => { if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'content-encoding') headers[key] = value; });
    res.writeHead(response.status, headers); res.end(Buffer.from(await response.arrayBuffer()));
  };
  return Object.freeze({
    async listen() {
      if (listening) return this.address();
      brokerBase = await resolveBrokerDiscovery(brokerDiscoveryUrl, fetchImpl);
      server = createServer(handler);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      listening = true; return this.address();
    },
    async close() { if (!server || !listening) return; await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); listening = false; },
    address() { return server?.address() ?? { address: host, port }; },
  });
}

export function oidcBootstrapFromDiscoveryUrl(brokerDiscoveryUrl) {
  const url = new URL(brokerDiscoveryUrl);
  const issuer = url.searchParams.get('oidc_issuer');
  const clientId = url.searchParams.get('oidc_client_id');
  const audience = url.searchParams.get('oidc_audience');
  const scopes = url.searchParams.get('oidc_scopes') ?? 'openid';
  if (!issuer || !clientId || !audience) throw new Error('Broker discovery URL must include public OIDC bootstrap parameters: oidc_issuer, oidc_client_id, and oidc_audience.');
  if (!validHttps(issuer) || !/^[^\s]+$/.test(clientId) || !/^[^\s]+$/.test(audience) || !/^(?:[A-Za-z0-9._:/-]+(?: [A-Za-z0-9._:/-]+)*)?$/.test(scopes)) throw new Error('Broker discovery URL contains invalid public OIDC bootstrap parameters.');
  return Object.freeze({ issuer, clientId, audience, scopes });
}

async function presentInBrowser(url) {
  const { spawn } = await import('node:child_process');
  const command = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  await new Promise((resolve) => {
    const child = spawn(command[0], command[1], { stdio: 'ignore', detached: true });
    child.once('error', resolve);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function createProductionSessionAdapter({ brokerDiscoveryUrl, loginFlow = publicOidcLogin, present = presentInBrowser } = {}) {
  const config = oidcBootstrapFromDiscoveryUrl(brokerDiscoveryUrl);
  await loginFlow(config, { present });
  return Object.freeze({
    async getValidatedAccessToken({ now } = {}) {
      const accessToken = getAccessToken(now);
      return accessToken ? { accessToken, expiresAt: Number.MAX_SAFE_INTEGER } : null;
    },
    clear: clearSession,
  });
}

export async function main(argv = process.argv.slice(2), { createSessionAdapter = createProductionSessionAdapter, createRuntime = createBridgeRuntime, runLauncher = runApplication } = {}) {
  const cli = parseCli(argv);
  if (cli.error) { console.error(`${cli.error}\n\n${usage()}`); return 2; }
  if (cli.command === 'help') { console.log(usage()); return 0; }
  if (cli.command === 'version') { console.log(`broker-bridge ${BRIDGE_VERSION}`); return 0; }
  if (cli.command === 'run') {
    let sessionAdapter; let runtime;
    try {
      sessionAdapter = await createSessionAdapter({ brokerDiscoveryUrl: cli.brokerDiscoveryUrl });
      runtime = createRuntime({ brokerDiscoveryUrl: cli.brokerDiscoveryUrl, sessionAdapter, host: cli.host, port: cli.port });
      await runtime.listen();
      const compatibilityEnv = compatibilityEnvironment({ preset: cli.preset, vendor: cli.preset ?? 'generic', host: cli.host, port: cli.port, mappings: cli.mappings });
      return await runLauncher({ application: cli.application, brokerDiscoveryUrl: cli.brokerDiscoveryUrl, compatibilityEnv, port: cli.port, bridgeAlreadyRunning: true });
    } catch (error) { console.error(`broker-bridge run failed: ${error.message}`); return 1; }
    finally { await sessionAdapter?.clear?.(); await runtime?.close?.(); }
  }
  let sessionAdapter;
  try { sessionAdapter = await createSessionAdapter({ brokerDiscoveryUrl: cli.brokerDiscoveryUrl }); }
  catch (error) { console.error(`broker-bridge login failed: ${error.message}`); return 2; }
  const runtime = createRuntime({ brokerDiscoveryUrl: cli.brokerDiscoveryUrl, sessionAdapter, host: cli.host, port: cli.port });
  const stop = async () => { await sessionAdapter.clear?.(); await runtime.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await runtime.listen(); return await new Promise(() => {}); }
  catch (error) { console.error(`broker-bridge serve failed: ${error.message}`); return 2; }
}

const cjsRequire = typeof require !== 'undefined' ? require : undefined;
const cjsModule = typeof module !== 'undefined' ? module : undefined;
const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (isCliEntry({ require: cjsRequire, module: cjsModule, metaUrl: import.meta.url, argvHref: invokedHref })) main().then((code) => { if (code !== undefined) process.exit(code); }).catch((error) => { console.error(error.message); process.exit(1); });

export { LOGIN_REQUIRED, MAX_DISCOVERY_BYTES };
