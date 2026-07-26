import { createPublicKey, verify } from 'node:crypto';
const forbiddenName = /secret|password|token|refresh|private.?key|api.?key|credential/i;
const forbiddenValue = /(?:offline_access|(?:client_)?secret\s*=|bearer\s+[A-Za-z0-9._-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/i;
const allowedPayload = new Set(['displayName', 'issuer', 'discovery', 'clientId', 'redirectUri', 'audience', 'audienceParameter', 'claims', 'assurance', 'bootstrap', 'grantType']);
const isPlain = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function canonicalizePackage(document) {
  const walk = (value) => { if (Array.isArray(value)) return value.map(walk); if (isPlain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, walk(value[key])])); if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value; throw new Error('Invalid registration package.'); };
  return JSON.stringify(walk(document));
}
export function scanForSecrets(value, path = '$') {
  if (Array.isArray(value)) { value.forEach((item, index) => scanForSecrets(item, `${path}[${index}]`)); return; }
  if (isPlain(value)) { for (const [key, item] of Object.entries(value)) { if (forbiddenName.test(key)) throw new Error('Registration package contains prohibited data.'); scanForSecrets(item, `${path}.${key}`); } return; }
  if (typeof value === 'string' && (forbiddenValue.test(value) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value))) throw new Error('Registration package contains prohibited data.');
}
function policy(document) {
  const payload = document.payload; if (!isPlain(payload) || Object.keys(payload).some((key) => !allowedPayload.has(key))) throw new Error('Invalid registration package.');
  scanForSecrets(document); if (document.format !== 'tessera-registration/v1' || document.version !== 1 || typeof document.signingKeyId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(document.signature || '')) throw new Error('Invalid registration package.');
  for (const field of ['issuer', 'clientId', 'redirectUri']) if (typeof payload[field] !== 'string' || !payload[field]) throw new Error('Invalid registration package.');
  const issuer = new URL(payload.issuer); const redirect = new URL(payload.redirectUri); if (issuer.protocol !== 'https:' || redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(redirect.hostname) || (payload.grantType && payload.grantType !== 'authorization_code')) throw new Error('Invalid registration package.');
  return Object.freeze({ issuer: payload.issuer.replace(/\/$/, ''), clientId: payload.clientId, redirectUri: payload.redirectUri, ...(payload.audience ? { audience: payload.audience } : {}), ...(payload.audienceParameter ? { audienceParameter: payload.audienceParameter } : {}), claims: Object.freeze({ ...(payload.claims || {}) }), assurance: Object.freeze({ ...(payload.assurance || {}) }) });
}
export function verifyRegistrationPackage({ packageDocument, keyring }) { const result = policy(packageDocument); const key = keyring?.[packageDocument.signingKeyId]; if (!key) throw new Error('Registration package signature is invalid.'); let publicKey; try { publicKey = key.type === 'public' ? key : createPublicKey(key); } catch { throw new Error('Registration package signature is invalid.'); } const signed = { format: packageDocument.format, version: packageDocument.version, signingKeyId: packageDocument.signingKeyId, payload: packageDocument.payload }; if (!verify(null, Buffer.from(canonicalizePackage(signed)), publicKey, Buffer.from(packageDocument.signature, 'base64url'))) throw new Error('Registration package signature is invalid.'); return result; }
export const renderGenericOidc = (document) => policy(document);
export const renderPrivateRegistration = (document, _provider) => policy(document);
export const renderMarketplaceInstallation = (document, _provider) => policy(document);
