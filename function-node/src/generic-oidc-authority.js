'use strict';
const { discover, verifyAccessToken } = require('./generic-oidc-validation');
function bearer(headers) { const m = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') || ''); if (!m) throw new Error('missing bearer'); return m[1]; }
function jsonSetting(value, name) { try { const parsed = JSON.parse(value || '{}'); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed; } catch { throw new Error(`invalid ${name}`); } }
function mappedStrings(claims, claim) { const value = claims[claim]; if (value === undefined) return []; const values = Array.isArray(value) ? value : [value]; if (!values.every((item) => typeof item === 'string' && item)) throw new Error(`invalid ${claim} claim`); return [...new Set(values)]; }
function checkAssurance(claims, assurance) { if (!Object.keys(assurance).length) return; const claim = assurance.claim; const equals = assurance.equals; if (typeof claim !== 'string' || typeof equals !== 'string' || claims[claim] !== equals) throw new Error('required assurance is missing'); }
async function validateRequest(req, { environment = process.env, fetcher = fetch, now = Date.now() } = {}) {
  if (req.headers.get('x-ms-client-principal') || req.headers.get('x-ms-token-aad-id-token')) throw new Error('platform principal headers are not accepted');
  const issuer = environment.GENERIC_OIDC_ISSUER, audience = environment.GENERIC_OIDC_AUDIENCE;
  if (!issuer || !audience) throw new Error('generic OIDC is not configured');
  const metadata = await discover(issuer, fetcher);
  const claims = await verifyAccessToken(bearer(req.headers), { issuer, audience, jwksUri: metadata.jwks_uri, fetcher }, now);
  const claimMap = jsonSetting(environment.GENERIC_OIDC_CLAIM_MAP, 'GENERIC_OIDC_CLAIM_MAP');
  const assurance = jsonSetting(environment.GENERIC_OIDC_ASSURANCE, 'GENERIC_OIDC_ASSURANCE');
  checkAssurance(claims, assurance);
  return { oid: claims.sub, azp: claims.azp || claims.sub, roles: mappedStrings(claims, claimMap.roles || 'roles'), groups: mappedStrings(claims, claimMap.groups || 'groups') };
}
module.exports = { validateRequest };
