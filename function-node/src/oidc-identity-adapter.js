'use strict';
const crypto = require('node:crypto');
const jwkCache = new Map();
const error = () => new Error('OIDC access token validation failed.');
const b64json = (part) => { try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { throw error(); } };
const httpsOrTestLoopback = (value) => { const url = new URL(value); return url.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname); };
const strings = (value) => [...new Set((Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((item) => typeof item === 'string'))];
async function json(fetchImpl, value) { if (!httpsOrTestLoopback(value)) throw error(); const response = await fetchImpl(value, { redirect: 'error' }); if (!response?.ok) throw error(); try { return await response.json(); } catch { throw error(); } }
async function keysFor(jwksUri, fetchImpl, refresh = false) {
  const current = jwkCache.get(jwksUri); if (!refresh && current?.expiresAt > Date.now()) return current.keys;
  const response = await fetchImpl(jwksUri, { redirect: 'error' }); if (!response?.ok) throw error(); let body; try { body = await response.json(); } catch { throw error(); }
  const maxAge = /max-age=(\d+)/i.exec(response.headers?.get?.('cache-control') || '')?.[1]; const ttl = Math.min(3_600_000, (Number(maxAge) || 300) * 1000);
  if (!Array.isArray(body?.keys)) throw error(); jwkCache.set(jwksUri, { keys: body.keys, expiresAt: Date.now() + ttl }); return body.keys;
}
function normalizeOidcClaims(payload, mapping = {}) {
  if (!payload || typeof payload !== 'object') throw error();
  const subject = mapping.oid || 'sub'; const client = mapping.azp || mapping.clientId || 'azp';
  const oid = payload[subject]; if (typeof oid !== 'string' || !oid) throw error();
  const azp = payload[client] || payload.client_id;
  const acr = payload[mapping.acr || 'acr']; const amr = strings(payload[mapping.amr || 'amr']);
  return Object.freeze({ oid, ...(typeof azp === 'string' && azp ? { azp } : {}), roles: Object.freeze(strings(payload[mapping.roles || 'roles'])), groups: Object.freeze(strings(payload[mapping.groups || 'groups'])), issuer: payload.iss, assurance: Object.freeze({ ...(typeof acr === 'string' ? { acr } : {}), ...(amr.length ? { amr: Object.freeze(amr) } : {}) }) });
}
async function validateOidcAccessToken({ token, config, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !config || typeof config.issuer !== 'string' || !config.audience) throw error();
  const parts = token.split('.'); if (parts.length !== 3) throw error(); const header = b64json(parts[0]); const payload = b64json(parts[1]);
  if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string') throw error();
  const issuer = config.issuer.replace(/\/$/, ''); const discovery = await json(fetchImpl, `${issuer}/.well-known/openid-configuration`);
  if (discovery.issuer !== issuer || typeof discovery.jwks_uri !== 'string') throw error();
  let keys = await keysFor(discovery.jwks_uri, fetchImpl); let jwk = keys.find((item) => item.kid === header.kid);
  if (!jwk) { keys = await keysFor(discovery.jwks_uri, fetchImpl, true); jwk = keys.find((item) => item.kid === header.kid); }
  if (!jwk) throw error(); let key; try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw error(); }
  const algorithm = header.alg === 'RS256' ? 'RSA-SHA256' : 'sha256'; if (!crypto.verify(algorithm, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw error();
  const now = Math.floor(Date.now() / 1000); const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== issuer || !audiences.includes(config.audience) || !Number.isInteger(payload.exp) || payload.exp <= now || (payload.nbf !== undefined && (!Number.isInteger(payload.nbf) || payload.nbf > now))) throw error();
  if (config.requiredAcr && payload[config.mapping?.acr || 'acr'] !== config.requiredAcr) throw error();
  const amr = strings(payload[config.mapping?.amr || 'amr']); if (Array.isArray(config.requiredAmr) && !config.requiredAmr.every((value) => amr.includes(value))) throw error();
  return normalizeOidcClaims(payload, config.mapping);
}
module.exports = { validateOidcAccessToken, normalizeOidcClaims };
