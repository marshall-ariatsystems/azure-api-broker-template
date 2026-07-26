import http from 'node:http';
import { authorizationParameters, createPkceTransaction, verifyCallback } from './oidc-pkce.mjs';

const failure = () => new Error('OIDC session failed.');
const localhost = (url) => url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
function approved(url, issuer) { return url.origin === issuer.origin && (url.protocol === 'https:' || localhost(url)); }

export async function discoverIssuer({ issuer, fetchImpl = fetch } = {}) {
  let base; try { base = new URL(issuer); } catch { throw failure(); }
  if (base.protocol !== 'https:' && !localhost(base)) throw failure();
  const response = await fetchImpl(new URL('/.well-known/openid-configuration', `${base.origin}/`), { redirect: 'error' });
  if (!response?.ok) throw failure();
  let metadata; try { metadata = await response.json(); } catch { throw failure(); }
  if (!metadata || metadata.issuer !== base.href.replace(/\/$/, '') || !['authorization_endpoint', 'token_endpoint', 'jwks_uri'].every((key) => typeof metadata[key] === 'string')) throw failure();
  const urls = Object.fromEntries(['authorization_endpoint', 'token_endpoint', 'jwks_uri'].map((key) => [key, new URL(metadata[key])]));
  if (!Object.values(urls).every((url) => approved(url, base))) throw failure();
  return Object.freeze({ issuer: base.href.replace(/\/$/, ''), ...urls });
}

export function createOidcSession({ fetchImpl = fetch, openBrowser = async () => {}, now = Date.now, randomBytes, createServer = http.createServer } = {}) {
  let accessToken;
  let expiresAt = 0;
  let activeServer;
  const clear = async () => { accessToken = undefined; expiresAt = 0; if (activeServer?.listening) await new Promise((resolve) => activeServer.close(resolve)); activeServer = undefined; };
  async function login(config) {
    if (!config || typeof config.clientId !== 'string' || !config.clientId || typeof config.scope !== 'string') throw failure();
    const scopes = config.scope.trim().split(/\s+/);
    if (!scopes.includes('openid') || scopes.includes('offline_access')) throw failure();
    if (config.audienceParameter && !['audience', 'resource'].includes(config.audienceParameter)) throw failure();
    const metadata = await discoverIssuer({ issuer: config.issuer, fetchImpl });
    const transaction = createPkceTransaction({ now, randomBytes });
    activeServer = createServer();
    await new Promise((resolve, reject) => { activeServer.once('error', reject); activeServer.listen(0, '127.0.0.1', resolve); });
    const address = activeServer.address(); const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const authorize = new URL(metadata.authorization_endpoint);
    const parameters = { ...authorizationParameters(transaction), client_id: config.clientId, redirect_uri: redirectUri, scope: config.scope };
    if (config.audienceParameter && config.audience) parameters[config.audienceParameter] = config.audience;
    authorize.search = new URLSearchParams(parameters);
    const code = await new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => { reject(failure()); }, 300_000);
      activeServer.once('request', (req, res) => {
        try { const callback = new URL(req.url, redirectUri); const value = verifyCallback({ transaction, state: callback.searchParams.get('state'), code: callback.searchParams.get('code'), now }); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Sign-in complete.'); clearTimeout(timer); resolve(value); }
        catch { res.writeHead(400); res.end(); clearTimeout(timer); reject(failure()); }
      });
      try { await openBrowser(authorize.toString()); } catch { clearTimeout(timer); reject(failure()); }
    });
    try {
      const response = await fetchImpl(metadata.token_endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: transaction.verifier, client_id: config.clientId, redirect_uri: redirectUri }).toString() });
      const tokens = await response.json();
      if (!response.ok || !tokens || typeof tokens.access_token !== 'string' || !tokens.access_token || Object.hasOwn(tokens, ['refresh', 'token'].join('_'))) throw failure();
      accessToken = tokens.access_token; expiresAt = now() + (Number.isFinite(tokens.expires_in) ? tokens.expires_in * 1000 : 300_000);
    } finally { if (activeServer?.listening) await new Promise((resolve) => activeServer.close(resolve)); activeServer = undefined; }
    return Object.freeze({ expiresAt });
  }
  return Object.freeze({ login, async getAccessToken() { return accessToken && expiresAt > now() ? accessToken : undefined; }, clear });
}
