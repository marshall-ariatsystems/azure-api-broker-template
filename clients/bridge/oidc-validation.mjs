import { createPublicKey, verify } from 'node:crypto';

const LIMIT = 256 * 1024;
const b64 = (part) => Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const json = (part) => JSON.parse(b64(part).toString('utf8'));
const fail = (message) => { throw new Error(`OIDC validation failed: ${message}`); };
const exactIssuer = (value) => String(value).replace(/\/+$/, '');

export async function fetchJson(url, fetcher = fetch) {
  const target = new URL(url);
  if (target.protocol !== 'https:') fail('HTTPS is required');
  const response = await fetcher(target, { redirect: 'error' });
  if (!response.ok) fail(`endpoint returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > LIMIT) fail('response exceeds 256 KiB');
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('invalid JSON'); }
}

export async function discover(issuer, fetcher = fetch) {
  const normalized = exactIssuer(issuer);
  if (!/^https:\/\//.test(normalized)) fail('issuer must be HTTPS');
  const value = await fetchJson(`${normalized}/.well-known/openid-configuration`, fetcher);
  if (exactIssuer(value.issuer) !== normalized || !value.jwks_uri || !value.authorization_endpoint || !value.token_endpoint) fail('invalid discovery metadata');
  for (const endpoint of [value.jwks_uri, value.authorization_endpoint, value.token_endpoint]) if (new URL(endpoint).protocol !== 'https:') fail('discovery endpoint must be HTTPS');
  return value;
}

function checkTime(payload, now) {
  const seconds = Math.floor(now / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= seconds || (Number.isFinite(payload.nbf) && payload.nbf > seconds) || (Number.isFinite(payload.iat) && payload.iat > seconds + 60)) fail('invalid token time');
}
function audience(payload, expected) {
  const values = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!values.includes(expected)) fail('invalid audience');
  if (values.length > 1 && payload.azp !== expected) fail('multi-audience token requires azp');
}
async function token(token, trust, now) {
  const parts = String(token).split('.');
  if (parts.length !== 3) fail('malformed JWT');
  let header; let payload;
  try { header = json(parts[0]); payload = json(parts[1]); } catch { fail('malformed JWT encoding'); }
  if (header.alg !== 'RS256' || !header.kid) fail('only RS256 with kid is accepted');
  const jwks = trust.jwks ?? await fetchJson(trust.jwksUri, trust.fetcher);
  const keys = Array.isArray(jwks.keys) ? jwks.keys.filter((key) => key.kid === header.kid && key.kty === 'RSA' && key.use !== 'enc') : [];
  if (keys.length !== 1) fail('unknown or ambiguous signing key');
  let key; try { key = createPublicKey({ key: keys[0], format: 'jwk' }); } catch { fail('invalid JWK'); }
  if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64(parts[2]))) fail('invalid signature');
  if (exactIssuer(payload.iss) !== exactIssuer(trust.issuer) || typeof payload.sub !== 'string' || !payload.sub) fail('invalid issuer or subject');
  audience(payload, trust.audience); checkTime(payload, now);
  return payload;
}
export async function verifyIdToken(value, trust, expectedNonce, now = Date.now()) { const payload = await token(value, trust, now); if (!expectedNonce || payload.nonce !== expectedNonce) fail('invalid nonce'); return payload; }
export async function verifyAccessToken(value, trust, now = Date.now()) { return token(value, trust, now); }
