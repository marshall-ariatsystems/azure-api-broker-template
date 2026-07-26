'use strict';
const crypto = require('node:crypto');
const { requireObject, rejectUnknownKeys } = require('./schema-utils');
const MAX_BYTES = 64 * 1024, PREFIX = 'registration package validation failed: ';
const SECRET_KEY = /secret|password|token|credential|private[_-]?key|api[_-]?key|client[_-]?secret|refresh/i;
const SECRET_VALUE = /-----BEGIN|client_secret=|(^|[^A-Za-z])Bearer\s+[A-Za-z0-9._~+/-]{16,}|eyJ[A-Za-z0-9_-]{14,}\.[A-Za-z0-9_-]{6,}\./;
const fail = (path) => { throw new Error(PREFIX + path); };
const freeze = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const object = (v, p) => requireObject(v, () => fail(p));
const exact = (v, keys, p) => rejectUnknownKeys(v, new Set(keys), (key) => fail(p + '.' + key));
const text = (v, p, n) => (typeof v !== 'string' || !v || v.length > n) ? fail(p) : v;
function scan(v, p = '$') { if (typeof v === 'string') { if (SECRET_VALUE.test(v)) fail(p); return; } if (!v || typeof v !== 'object') return; for (const [k, child] of Object.entries(v)) { if (SECRET_KEY.test(k)) fail(p + '.' + k); scan(child, p + '.' + k); } }
function url(v, p, redirect = false) { let u; try { u = new URL(v); } catch { fail(p); } if (redirect ? !(u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')) : u.protocol !== 'https:') fail(p); return redirect ? v : v.replace(/\/+$/, ''); }
function content(v, p = '$.package') {
  object(v, p); exact(v, ['id','displayName','discovery','redirectUris','resource','claims','assurance','bootstrap'], p);
  const id = text(v.id, p + '.id', 71); if (!/^regpkg:[a-z0-9][a-z0-9-]{0,63}$/.test(id)) fail(p + '.id');
  const displayName = text(v.displayName, p + '.displayName', 128);
  object(v.discovery, p + '.discovery'); exact(v.discovery, ['issuer'], p + '.discovery');
  const issuer = url(text(v.discovery.issuer, p + '.discovery.issuer', 2048), p + '.discovery.issuer');
  if (!Array.isArray(v.redirectUris) || !v.redirectUris.length || v.redirectUris.length > 8) fail(p + '.redirectUris');
  const redirectUris = v.redirectUris.map((x, i) => url(text(x, p + '.redirectUris.' + i, 2048), p + '.redirectUris.' + i, true)); if (new Set(redirectUris).size !== redirectUris.length) fail(p + '.redirectUris');
  object(v.resource, p + '.resource'); exact(v.resource, ['audience'], p + '.resource'); const audience = text(v.resource.audience, p + '.resource.audience', 256); if (/\s/.test(audience)) fail(p + '.resource.audience');
  object(v.claims, p + '.claims'); exact(v.claims, ['roles','groups'], p + '.claims');
  const claim = (x, n) => { x = text(x, p + '.claims.' + n, 64); if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(x)) fail(p + '.claims.' + n); return x; };
  const claims = { roles: claim(v.claims.roles, 'roles'), groups: claim(v.claims.groups, 'groups') };
  object(v.assurance, p + '.assurance'); exact(v.assurance, ['claim','equals'], p + '.assurance'); const ak = Object.keys(v.assurance); if (ak.length && ak.length !== 2) fail(p + '.assurance');
  const assurance = ak.length ? { claim: text(v.assurance.claim, p + '.assurance.claim', 64), equals: text(v.assurance.equals, p + '.assurance.equals', 256) } : {}; if (assurance.claim && !/^[a-zA-Z0-9_.:-]{1,64}$/.test(assurance.claim)) fail(p + '.assurance.claim');
  if (!Array.isArray(v.bootstrap) || v.bootstrap.length > 16) fail(p + '.bootstrap'); const bootstrap = v.bootstrap.map((x, i) => text(x, p + '.bootstrap.' + i, 512));
  return freeze({ id, displayName, discovery: { issuer }, redirectUris, resource: { audience }, claims, assurance, bootstrap });
}
function canonicalJson(v) { if (v === null || ['string','number','boolean'].includes(typeof v)) return JSON.stringify(v); if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'; if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) throw new TypeError('canonical JSON requires plain JSON'); return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'; }
function parseRegistrationPackage(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BYTES) fail('$'); let d; try { d = JSON.parse(raw); } catch { fail('$'); }
  scan(d); object(d, '$'); exact(d, ['formatVersion','package','signature'], '$'); if (d.formatVersion !== 1) fail('$.formatVersion'); const pkg = content(d.package);
  object(d.signature, '$.signature'); exact(d.signature, ['algorithm','publicKeySpki','value'], '$.signature'); if (d.signature.algorithm !== 'Ed25519') fail('$.signature.algorithm');
  for (const k of ['publicKeySpki','value']) if (typeof d.signature[k] !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(d.signature[k])) fail('$.signature.' + k);
  return freeze({ formatVersion: 1, package: pkg, signature: { algorithm: 'Ed25519', publicKeySpki: d.signature.publicKeySpki, value: d.signature.value } });
}
function signRegistrationPackage(input, privateKey) {
  scan(input, '$.package'); const pkg = content(input); if (!(privateKey instanceof crypto.KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') fail('$.privateKey');
  const publicKeySpki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'); const value = crypto.sign(null, Buffer.from(canonicalJson(pkg)), privateKey).toString('base64');
  return freeze({ formatVersion: 1, package: pkg, signature: { algorithm: 'Ed25519', publicKeySpki, value } });
}
function checked(raw, options = {}, inspect = false) {
  const doc = parseRegistrationPackage(raw); if (options.trustedPublicKeySpki !== undefined && options.trustedPublicKeySpki !== doc.signature.publicKeySpki) throw new Error('untrusted signing key');
  try { const key = crypto.createPublicKey({ key: Buffer.from(doc.signature.publicKeySpki, 'base64'), format: 'der', type: 'spki' }); const valid = key.asymmetricKeyType === 'ed25519' && crypto.verify(null, Buffer.from(canonicalJson(doc.package)), key, Buffer.from(doc.signature.value, 'base64')); if (!valid && !inspect) fail('$.signature'); return { doc, valid }; } catch (e) { if (String(e.message).startsWith(PREFIX)) throw e; if (inspect) return { doc, valid: false }; fail('$.signature'); }
}
function verifyRegistrationPackage(raw, options) { return checked(raw, options).doc; }
function inspectRegistrationPackage(raw) { const { doc, valid } = checked(raw, {}, true), p = doc.package; return freeze({ signatureState: valid ? 'valid' : 'invalid', keyFingerprint: crypto.createHash('sha256').update(Buffer.from(doc.signature.publicKeySpki, 'base64')).digest('hex'), lines: ['id: ' + p.id, 'displayName: ' + p.displayName, 'discovery: ' + p.discovery.issuer, 'redirectUris: ' + p.redirectUris.join(', '), 'resource: ' + p.resource.audience, 'claims: ' + canonicalJson(p.claims), 'assurance: ' + canonicalJson(p.assurance), 'bootstrap: ' + p.bootstrap.join(' | ')] }); }
module.exports = { canonicalJson, parseRegistrationPackage, signRegistrationPackage, verifyRegistrationPackage, inspectRegistrationPackage };
