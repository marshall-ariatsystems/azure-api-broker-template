import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 300_000;
const genericFailure = () => new Error('OIDC callback validation failed.');
const b64url = (value) => Buffer.from(value).toString('base64url');

export function createPkceTransaction({ now = Date.now, randomBytes = cryptoRandomBytes } = {}) {
  const issuedAt = now();
  const verifier = b64url(randomBytes(32));
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new Error('OIDC PKCE generation failed.');
  return Object.freeze({
    verifier,
    codeChallenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    state: b64url(randomBytes(32)),
    nonce: b64url(randomBytes(32)),
    expiresAt: issuedAt + TTL_MS,
  });
}

export function verifyCallback({ transaction, state, code, now = Date.now } = {}) {
  if (!transaction || typeof code !== 'string' || !code || typeof state !== 'string' || now() > transaction.expiresAt) throw genericFailure();
  const expected = Buffer.from(transaction.state || '');
  const received = Buffer.from(state);
  if (!expected.length || expected.length !== received.length || !timingSafeEqual(expected, received)) throw genericFailure();
  return code;
}

export function authorizationParameters(transaction) {
  return Object.freeze({ response_type: 'code', code_challenge_method: 'S256', code_challenge: transaction.codeChallenge, state: transaction.state, nonce: transaction.nonce });
}
