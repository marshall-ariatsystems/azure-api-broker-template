'use strict';
const crypto = require('node:crypto');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-oidc-parity-0001';
const ISSUER = 'https://issuer.parity.test';
const AUDIENCE = 'broker-audience';
const JWKS_URI = 'https://issuer.parity.test/jwks';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };
const JWKS = Object.freeze({ keys: Object.freeze([Object.freeze(jwk)]) });
const DISCOVERY_OK = Object.freeze({ issuer: ISSUER, jwks_uri: JWKS_URI, authorization_endpoint: 'https://issuer.parity.test/authorize', token_endpoint: 'https://issuer.parity.test/token' });
const DISCOVERY_HTTP_TOKEN = Object.freeze({ issuer: ISSUER, jwks_uri: JWKS_URI, authorization_endpoint: 'https://issuer.parity.test/authorize', token_endpoint: 'http://issuer.parity.test/token' });
const NOW_MS = Date.parse('2026-07-26T00:00:00Z');
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function signAccessToken(claimOverrides = {}, header = { alg: 'RS256', kid: KID, typ: 'JWT' }) { const nowSec = Math.floor(NOW_MS / 1000); const claims = { iss: ISSUER, aud: AUDIENCE, sub: 'subject-parity', iat: nowSec, exp: nowSec + 3600, ...claimOverrides }; const signingInput = `${b64url(header)}.${b64url(claims)}`; const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url'); return `${signingInput}.${sig}`; }
function makeFetcher(discovery = DISCOVERY_OK, jwks = JWKS) { const calls = { discovery: 0, jwks: 0 }; const fetcher = async (url) => { const href = String(url); if (href.endsWith('/.well-known/openid-configuration')) { calls.discovery++; return jsonResponse(discovery); } if (href === JWKS_URI) { calls.jwks++; return jsonResponse(jwks); } throw new Error(`unexpected fetch ${href}`); }; return { fetcher, calls }; }
function jsonResponse(obj) { const body = Buffer.from(JSON.stringify(obj)); return { ok: true, status: 200, headers: { get: () => 'max-age=300' }, async arrayBuffer() { return body; }, async json() { return JSON.parse(body.toString('utf8')); } }; }
const FUTURE_IAT_OFFSET_SEC = 120;
module.exports = Object.freeze({ publicKey, privateKey, KID, ISSUER, AUDIENCE, JWKS_URI, JWKS, DISCOVERY_OK, DISCOVERY_HTTP_TOKEN, NOW_MS, FUTURE_IAT_OFFSET_SEC, b64url, signAccessToken, makeFetcher, jsonResponse });
