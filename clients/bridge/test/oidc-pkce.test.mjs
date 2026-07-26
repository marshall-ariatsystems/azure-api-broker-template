import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { authorizationParameters, createPkceTransaction, verifyCallback } from '../oidc-pkce.mjs';
test('PKCE transaction uses independent S256 vector and expires safely', () => {
  const transaction = createPkceTransaction({ now: () => 1_000, randomBytes: () => Buffer.alloc(32, 7) });
  assert.equal(transaction.verifier.length, 43);
  assert.equal(transaction.codeChallenge, createHash('sha256').update(transaction.verifier, 'ascii').digest('base64url'));
  assert.deepEqual(authorizationParameters(transaction), { response_type: 'code', code_challenge_method: 'S256', code_challenge: transaction.codeChallenge, state: transaction.state, nonce: transaction.nonce });
  assert.equal(verifyCallback({ transaction, state: transaction.state, code: 'code', now: () => 301_000 }), 'code');
  for (const value of [{ state: 'wrong', code: 'code', now: () => 1_000 }, { state: transaction.state, code: '', now: () => 1_000 }, { state: transaction.state, code: 'code', now: () => 301_001 }]) assert.throws(() => verifyCallback({ transaction, ...value }), /OIDC callback validation failed/);
  assert.equal(JSON.stringify(transaction).includes('token'), false);
});
