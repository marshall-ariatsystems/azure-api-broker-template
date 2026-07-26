import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createOidcSession, discoverIssuer } from '../oidc-session.mjs';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
test('memory-only session uses trusted discovery and exact code exchange fields', async () => {
  let form; let opened; const server = http.createServer((req, res) => { const base = `http://127.0.0.1:${server.address().port}`; if (req.url.startsWith('/.well-known')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/keys` })); } if (req.url === '/token') { let body=''; req.on('data', (part) => body += part); req.on('end', () => { form = new URLSearchParams(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'access-only', expires_in: 60 })); }); return; } res.end('{}'); }); await listen(server); const issuer = `http://127.0.0.1:${server.address().port}`;
  const session = createOidcSession({ openBrowser: async (url) => { opened = new URL(url); setImmediate(() => http.get(`${opened.searchParams.get('redirect_uri')}?state=${opened.searchParams.get('state')}&code=one`)); } });
  await session.login({ issuer, clientId: 'public', scope: 'openid profile', audience: 'broker', audienceParameter: 'audience' });
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256'); assert.equal(opened.searchParams.get('audience'), 'broker'); assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.has('client_secret'), false); assert.equal(await session.getAccessToken(), 'access-only'); await session.clear(); assert.equal(await session.getAccessToken(), undefined); await close(server);
});
test('discovery rejects endpoints controlled by another origin', async () => { await assert.rejects(discoverIssuer({ issuer: 'http://127.0.0.1:1', fetchImpl: async () => ({ ok: true, json: async () => ({ issuer: 'http://127.0.0.1:1', authorization_endpoint: 'http://evil.test/a', token_endpoint: 'http://evil.test/t', jwks_uri: 'http://evil.test/k' }) }) })); });
