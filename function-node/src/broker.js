// broker.js — minimal Entra-fronted vendor key broker (Node 22 / @azure/functions v4).
//
// Trust model: Microsoft Entra Easy Auth (platform-level) has ALREADY validated the caller's
// token before this code runs (requireAuthentication=true, unauthenticatedClientAction=Return401,
// allowedApplications/allowedAudiences enforced). This function therefore:
//   1. reads the caller's app roles from the injected x-ms-client-principal header,
//   2. selects EXACTLY ONE vendor key by role (403 if zero or more-than-one match),
//   3. fetches that key from Key Vault via the app's system-assigned managed identity (cached),
//   4. strips every caller-supplied credential location (allowlist), injects the real key
//      server-side (Bearer or header per INJECT_MODE), and forwards to the vendor,
//   5. returns only the vendor response. The real key never leaves Azure.

const { app } = require('@azure/functions');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const scrubber = require('./credential-scrubber');
const rateLimiter = require('./rate-limiter');

const KEYVAULT_URI = process.env.KEYVAULT_URI;
const VENDOR_BASE_URL = (process.env.VENDOR_BASE_URL || '').replace(/\/+$/, '');
// header | bearer: secret value is a single opaque key.
// pair | basic: secret value is a JSON blob {"keyId":"…","secret":"…"} stored as ONE Key Vault
// secret so the two halves rotate atomically (never a new keyId with a stale secret).
const INJECT_MODE = (process.env.INJECT_MODE || 'header').toLowerCase();
const KEY_HEADER_NAME = (process.env.VENDOR_KEY_HEADER_NAME || 'x-api-key').toLowerCase();
const KEYID_HEADER_NAME = (process.env.VENDOR_KEYID_HEADER_NAME || 'x-api-key-id').toLowerCase();
const SECRET_HEADER_NAME = (process.env.VENDOR_SECRET_HEADER_NAME || 'x-api-secret').toLowerCase();

// Authoritative role -> vendor mapping (spec §5.1 / identity/app-roles.json).
// Overridable via app setting ROLE_SECRET_MAP (JSON) so new roles/secrets need no redeploy:
//   { "RoleValue": "secret-name" }                                — secret only, global vendor
//   { "RoleValue": {"secret":"name","baseUrl":"https://…","inject":"bearer"} } — per-role vendor
// baseUrl/inject fall back to VENDOR_BASE_URL / INJECT_MODE when omitted.
const DEFAULT_ROLE_MAP = {
  'VendorApi.KeyA.Invoke': 'vendor-key-a',
  'VendorApi.KeyB.Invoke': 'vendor-key-b',
  'VendorApi.KeyC.Invoke': 'vendor-key-c',
};
function loadRoleMap() {
  const raw = process.env.ROLE_SECRET_MAP;
  if (!raw) return DEFAULT_ROLE_MAP;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  console.error('ROLE_SECRET_MAP is not a valid JSON object; using built-in defaults');
  return DEFAULT_ROLE_MAP;
}
const ROLE_TO_SECRET = Object.freeze(loadRoleMap());
// Normalize a map entry to { secret, baseUrl, inject } with global fallbacks.
function vendorForRole(role) {
  const entry = ROLE_TO_SECRET[role];
  if (typeof entry === 'string') return { secret: entry, baseUrl: VENDOR_BASE_URL, inject: INJECT_MODE };
  return {
    secret: entry.secret,
    baseUrl: (entry.baseUrl || VENDOR_BASE_URL).replace(/\/+$/, ''),
    inject: (entry.inject || INJECT_MODE).toLowerCase(),
    tokenUrl: entry.tokenUrl,
    scope: entry.scope,
    idField: entry.idField,
    secretField: entry.secretField,
  };
}

// --- vendor-named routing ----------------------------------------------------------------------
// Legacy rule: the caller must hold EXACTLY ONE vendor role, else 403. That breaks the moment a
// single Entra identity is assigned several vendor roles on the broker Enterprise App — its token
// then carries them all and every call 403s. To let one identity serve many vendors, a caller MAY
// name the vendor as the first path segment (/broker/<vendor>/<subpath>); the broker authorizes on
// the caller HOLDING that vendor's role. Security is unchanged: the roles claim is still populated
// only by Enterprise App app-role assignments; naming a vendor you were not assigned still 403s.
// Slug = the middle segment of the role value, lowercased (VendorApi.Graph.Invoke -> "graph"); a
// "route" field on a ROLE_SECRET_MAP entry overrides it.
function slugForRole(role, entry) {
  if (entry && typeof entry === 'object' && entry.route) return String(entry.route).toLowerCase();
  const m = /^VendorApi\.(.+)\.Invoke$/i.exec(role);
  return (m ? m[1] : role).toLowerCase();
}
const SLUG_TO_ROLE = Object.freeze(Object.fromEntries(
  Object.entries(ROLE_TO_SECRET).map(([role, entry]) => [slugForRole(role, entry), role]),
));
// OFF by default = spec §3c preserved exactly (EXACT one-role match, multi/zero -> 403). Set to
// true ONLY when you intend one Entra identity to hold several vendor roles and pick per request
// via /broker/<vendor>/... — this is the deliberate relaxation of the "one token = one key"
// tripwire that the drop-in bridge requires. The named role is still enforced (fail-closed on
// role-not-held); the trade is that a compromised multi-role token can reach every vendor it holds.
const MULTI_ROLE_VENDOR_ROUTING = /^(1|true)$/i.test(process.env.MULTI_ROLE_VENDOR_ROUTING || '');

// Register deployment-configured injection headers as credential-shaped (spec §6.3).
// These are REJECTED if the caller supplies them (not silently dropped), to surface smuggling attempts.
scrubber.addInjectionHeadersToCredentialSet(KEY_HEADER_NAME, KEYID_HEADER_NAME, SECRET_HEADER_NAME);

// pair/basic/oauth2cc modes: the KV secret must be a JSON object holding the two halves.
// Field names default to keyId/secret (client_id/client_secret also accepted) and can be
// overridden per role via idField/secretField in ROLE_SECRET_MAP. Explicit mode per
// deployment (no shape-sniffing) so a mis-formatted secret fails loudly, not silently.
function parsePairSecret(raw, vendor) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const id = obj[vendor.idField] ?? obj.keyId ?? obj.client_id;
  const secret = obj[vendor.secretField] ?? obj.secret ?? obj.client_secret;
  if (typeof id !== 'string' || typeof secret !== 'string') return null;
  return { keyId: id, secret };
}

// oauth2cc: exchange the pair for a short-lived vendor access token (client_credentials) and
// inject THAT as Bearer. Tokens cached per secret until 60s before expiry.
const oauthTokenCache = new Map(); // secretName -> { token, exp }
// forceRefresh re-mints even on a warm cache — used for reactive recovery when the vendor rejects a
// cached token with 401 (rotation / revocation / clock skew; FR-3). ctx is optional so soak evidence
// (mint vs cache-hit cadence, thrash) lands in App Insights traces.
async function getOauthToken(secretName, vendor, pair, { forceRefresh = false, ctx } = {}) {
  const now = Date.now();
  if (!forceRefresh) {
    const hit = oauthTokenCache.get(secretName);
    if (hit && hit.exp > now) {
      if (ctx) ctx.log(`[broker] oauth token cache-hit secret=${secretName}`);
      return hit.token;
    }
  }
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: pair.keyId,
    client_secret: pair.secret,
  });
  if (vendor.scope) form.set('scope', vendor.scope);
  const resp = await fetch(vendor.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!resp.ok) throw new Error(`token endpoint ${resp.status}`);
  const tok = await resp.json();
  if (!tok.access_token) throw new Error('token endpoint returned no access_token');
  const ttlMs = (typeof tok.expires_in === 'number' ? tok.expires_in : 300) * 1000;
  oauthTokenCache.set(secretName, { token: tok.access_token, exp: now + ttlMs - 60_000 });
  if (ctx) ctx.log(`[broker] oauth token ${forceRefresh ? 'RE-MINT' : 'MINT'} secret=${secretName} ttl=${Math.round(ttlMs / 1000)}s`);
  return tok.access_token;
}

// Hop-by-hop / platform headers never forwarded to the vendor.
const HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

const credential = new DefaultAzureCredential();
const secretClient = KEYVAULT_URI ? new SecretClient(KEYVAULT_URI, credential) : null;

// In-memory secret cache, TTL 5 min (spec §7). Cleared naturally on cold start / restart.
const SECRET_TTL_MS = 5 * 60 * 1000;
const secretCache = new Map(); // name -> { value, exp }

async function getSecret(name) {
  const now = Date.now();
  const hit = secretCache.get(name);
  if (hit && hit.exp > now) return hit.value;
  const s = await secretClient.getSecret(name);
  secretCache.set(name, { value: s.value, exp: now + SECRET_TTL_MS });
  return s.value;
}

const DEMO_MODE = (process.env.DEMO_MODE || '').toLowerCase() === '1' ||
                  (process.env.DEMO_MODE || '').toLowerCase() === 'true';

// Extract app roles + caller object id from the Easy Auth client-principal header.
function rolesFromPrincipal(req) {
  const b64 = req.headers.get('x-ms-client-principal');
  if (!b64) return { roles: [], claimTypes: [], oid: null, azp: null };
  let json;
  try { json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); }
  catch { return { roles: [], claimTypes: [], oid: null, azp: null }; }
  const claims = Array.isArray(json.claims) ? json.claims : [];
  const roleTyp = (json.role_typ || '').toLowerCase();
  const roles = [];
  const claimTypes = new Set();
  let oid = null;
  let azp = null;
  for (const c of claims) {
    const t = (c.typ || '').toLowerCase();
    claimTypes.add(t);
    if (t === 'roles' || t === 'role' || t === roleTyp ||
        t.endsWith('/identity/claims/role')) {
      if (c.val) roles.push(c.val);
    }
    if (t === 'oid' || t.endsWith('/identity/claims/objectidentifier')) oid = c.val;
    if (t === 'azp' || t === 'appid') azp = c.val;
  }
  return { roles, claimTypes: [...claimTypes], oid, azp };
}

app.http('broker', {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  authLevel: 'anonymous', // Easy Auth enforces authN/authZ at the platform layer.
  route: 'broker/{*path}',
  handler: async (req, ctx) => {
    if (!secretClient) return { status: 500, jsonBody: { error: 'KEYVAULT_URI not configured' } };

    const startedAt = Date.now();
    // 1. Select the vendor role. Vendor-named path wins; otherwise the legacy exactly-one rule.
    const { roles, claimTypes, oid, azp } = rolesFromPrincipal(req);
    const held = new Set(roles.filter((r) => ROLE_TO_SECRET[r]));
    const rawPath = req.params.path || '';
    const segs = rawPath.split('/').filter(Boolean);
    const namedRole = segs.length ? SLUG_TO_ROLE[segs[0].toLowerCase()] : undefined;
    let selectedRole;
    let subpath;
    if (namedRole && MULTI_ROLE_VENDOR_ROUTING) {
      // /broker/<vendor>/<subpath> — authorize on HOLDING the named role (multi-role identities OK).
      if (!held.has(namedRole)) {
        ctx.log(`[broker] DENY oid=${oid} azp=${azp} vendor=${segs[0]} role-not-held (403)`);
        return {
          status: 403,
          jsonBody: {
            error: 'caller lacks the named vendor app-role',
            vendor: segs[0],
            seenClaimTypes: claimTypes, // types only, no values — safe debug aid
          },
        };
      }
      selectedRole = namedRole;
      subpath = segs.slice(1).join('/');
    } else {
      // Legacy path (unchanged): exactly one vendor role, subpath = the full caller path.
      const single = [...held];
      if (single.length !== 1) {
        ctx.log(`[broker] DENY oid=${oid} azp=${azp} matchedRoles=${single.length} (403)`);
        return {
          status: 403,
          jsonBody: {
            error: 'exactly one vendor app-role required, or name the vendor in the path (/broker/<vendor>/...)',
            matchedRoles: single.length,
            seenClaimTypes: claimTypes, // types only, no values — safe debug aid
          },
        };
      }
      selectedRole = single[0];
      subpath = rawPath;
    }
    const vendor = vendorForRole(selectedRole);
    const secretName = vendor.secret;
    if (!secretName) {
      ctx.error(`ROLE_SECRET_MAP entry for ${selectedRole} has no secret name`);
      return { status: 500, jsonBody: { error: 'vendor key mapping misconfigured' } };
    }
    if (!vendor.baseUrl) {
      ctx.error(`no vendor base URL for role ${selectedRole} (set VENDOR_BASE_URL or a per-role baseUrl)`);
      return { status: 500, jsonBody: { error: 'vendor base URL not configured' } };
    }

    // 2. Enforce the distributed per-caller and per-key quota (spec §9) BEFORE touching Key Vault.
    //    Ordering matters: a caller flooding the broker would otherwise drive one Key Vault request
    //    per inbound request until the cache warms, burning KV throttling budget (and cost) on
    //    traffic that is about to be rejected anyway. Quota is the cheapest possible gate, so it
    //    runs first.
    const quotaResult = await rateLimiter.quotaCheck(oid, secretName, ctx);
    if (!quotaResult.ok) {
      return {
        status: 429,
        headers: { 'Retry-After': String(quotaResult.retryAfterSeconds) },
        jsonBody: { error: quotaResult.reason, retryAfterSeconds: quotaResult.retryAfterSeconds },
      };
    }

    // 3. Fetch the real key from Key Vault (managed identity).
    let vendorKey;
    try {
      vendorKey = await getSecret(secretName);
    } catch (e) {
      ctx.error(`key vault fetch failed for ${secretName}: ${e.message}`);
      return { status: 502, jsonBody: { error: 'vendor key unavailable' } };
    }

    // 4. Validate caller input (spec §6.3: fail-closed for credential-shaped fields).
    //    Query parameters: reject credential-shaped names (URL-decoded, case-insensitive).
    //    Body: reject credential-shaped fields (JSON, form-urlencoded; fail-closed on parse error).
    //    Headers: allowlist non-credential headers; reject if credential-shaped.
    const qs = req.query.toString();
    const queryCheck = scrubber.checkQueryParameters(qs);
    if (!queryCheck.ok) {
      ctx.log(`[broker] REJECT oid=${oid} query-param=${queryCheck.field} (400)`);
      return {
        status: 400,
        jsonBody: { error: `credential-shaped query parameter not allowed: ${queryCheck.field}` },
      };
    }

    // Read request body once; check for credential-shaped fields before forwarding.
    const method = req.method.toUpperCase();
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.length) {
        const bodyCheck = scrubber.checkRequestBody(buf, req.headers.get('content-type'));
        if (!bodyCheck.ok) {
          ctx.log(`[broker] REJECT oid=${oid} body-field=${bodyCheck.field} (400)`);
          return {
            status: 400,
            jsonBody: { error: `credential-shaped body field not allowed: ${bodyCheck.field}` },
          };
        }
        body = buf;
      }
    }

    // Headers: allowlist non-credential headers; reject (not silently drop) credential-shaped.
    // Injection header names must be checked as part of credential detection.
    const headerCheck = scrubber.filterRequestHeaders(req.headers, [KEY_HEADER_NAME, KEYID_HEADER_NAME, SECRET_HEADER_NAME]);
    if (!headerCheck.ok) {
      ctx.log(`[broker] REJECT oid=${oid} header=${headerCheck.field} (400)`);
      return {
        status: 400,
        jsonBody: { error: `credential-shaped header not allowed: ${headerCheck.field}` },
      };
    }
    const outHeaders = headerCheck.headers;

    // 5. Build the vendor URL: vendor.baseUrl + caller subpath (vendor slug already stripped) + query.
    const url = vendor.baseUrl + (subpath ? '/' + subpath : '') + (qs ? '?' + qs : '');
    let pair = null;
    if (vendor.inject === 'pair' || vendor.inject === 'basic' || vendor.inject === 'oauth2cc') {
      pair = parsePairSecret(vendorKey, vendor);
      if (!pair) {
        ctx.error(`secret ${secretName} is not a valid JSON pair (inject=${vendor.inject})`);
        return { status: 500, jsonBody: { error: 'vendor key pair misconfigured' } };
      }
      if (vendor.inject === 'oauth2cc') {
        if (!vendor.tokenUrl) {
          ctx.error(`role ${selectedRole} uses oauth2cc but has no tokenUrl in ROLE_SECRET_MAP`);
          return { status: 500, jsonBody: { error: 'vendor token endpoint not configured' } };
        }
        let accessToken;
        try {
          accessToken = await getOauthToken(secretName, vendor, pair, { ctx });
        } catch (e) {
          ctx.error(`vendor oauth exchange failed for ${secretName}: ${e.message}`);
          return { status: 502, jsonBody: { error: 'vendor token exchange failed' } };
        }
        outHeaders['authorization'] = `Bearer ${accessToken}`;
      } else if (vendor.inject === 'basic') {
        outHeaders['authorization'] = `Basic ${Buffer.from(`${pair.keyId}:${pair.secret}`).toString('base64')}`;
      } else {
        outHeaders[KEYID_HEADER_NAME] = pair.keyId;
        outHeaders[SECRET_HEADER_NAME] = pair.secret;
      }
    } else if (vendor.inject === 'bearer') outHeaders['authorization'] = `Bearer ${vendorKey}`;
    else outHeaders[KEY_HEADER_NAME] = vendorKey;

    // 5. Call the vendor, with bounded reactive recovery (FR-3):
    //    - oauth2cc 401: the cached vendor token was rejected (rotation/revocation/skew) -> re-mint
    //      once and retry (safe for any method — a 401 means the request was not processed).
    //    - transient 5xx: one jittered retry, but ONLY for idempotent methods (GET/HEAD) — never
    //      re-send a non-idempotent POST/PATCH the origin may have already partially applied.
    const idempotent = method === 'GET' || method === 'HEAD';
    let vresp;
    let reminted = false;
    let retried5xx = false;
    while (true) {
      try {
        vresp = await fetch(url, { method, headers: outHeaders, body });
      } catch (e) {
        ctx.error(`vendor request failed: ${e.message}`);
        return { status: 502, jsonBody: { error: 'vendor request failed' } };
      }
      if (vresp.status === 401 && vendor.inject === 'oauth2cc' && !reminted) {
        reminted = true;
        ctx.log(`[broker] RECOVER 401 -> re-mint oauth token secret=${secretName} vendor=${subpath || '/'}`);
        try {
          outHeaders['authorization'] = `Bearer ${await getOauthToken(secretName, vendor, pair, { forceRefresh: true, ctx })}`;
          continue; // retry once with the fresh token
        } catch (e) {
          ctx.error(`re-mint after 401 failed for ${secretName}: ${e.message}`); // fall through: return the 401
        }
      }
      const retriable5xx = vresp.status >= 500 && idempotent;
      if (retriable5xx && !retried5xx) {
        retried5xx = true;
        const backoffMs = 200 + Math.floor(Math.random() * 300); // 200-500ms jitter
        ctx.log(`[broker] RETRY ${vresp.status} secret=${secretName} vendor=${subpath || '/'} in=${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      break;
    }

    // 6. Scrub vendor response (spec §6.3): remove credential-shaped headers + redact response body.
    //    Symmetric to request validation — an upstream vendor error might echo a credential.
    const respBufRaw = Buffer.from(await vresp.arrayBuffer());
    const contentType = vresp.headers.get('content-type');
    const { buffer: respBuf } = scrubber.scrubResponseBody(respBufRaw, contentType);

    const respHeadersScrubbed = scrubber.scrubResponseHeaders(vresp.headers);
    const respHeaders = {};
    for (const [key, val] of Object.entries(respHeadersScrubbed)) {
      const lk = key.toLowerCase();
      // fetch already decompressed the body, so drop encoding/length/hop headers.
      if (HOP_HEADERS.has(lk) || lk === 'content-encoding' || lk === 'content-length') continue;
      respHeaders[key] = val;
    }

    // Backend audit line — shows auth + role + injection + vendor status. NEVER logs the key/token.
    const elapsed = Date.now() - startedAt;
    ctx.log(`[broker] ALLOW oid=${oid} azp=${azp} role=${selectedRole} -> secret=${secretName} ` +
            `inject=${vendor.inject} vendor=${subpath || '/'} status=${vresp.status} ${elapsed}ms`);

    // Demo-only: surface what the broker did (redacted — names/status only, never the key value),
    // so a frontend can display the server-side actions without ever seeing a credential.
    if (DEMO_MODE) {
      respHeaders['x-broker-caller-oid'] = oid || 'unknown';
      respHeaders['x-broker-role'] = selectedRole;
      respHeaders['x-broker-secret-name'] = secretName;
      respHeaders['x-broker-inject-mode'] = vendor.inject;
      respHeaders['x-broker-vendor-status'] = String(vresp.status);
      respHeaders['x-broker-key-present-on-client'] = 'false';
    }
    return { status: vresp.status, headers: respHeaders, body: respBuf };
  },
});

// Lightweight health/soak probe — no secret access, no vendor call. Surfaces per-instance uptime and
// cache sizes so a multi-week dry-run can chart availability + token-cache behavior.
// NOTE: Easy Auth still gates this at the platform layer (unauthenticatedClientAction=Return401). For
// an UNAUTHENTICATED availability test, add '/api/health' to Easy Auth globalValidation.excludedPaths;
// a token-carrying probe works as-is.
const BOOTED_AT = Date.now();
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async () => ({
    status: 200,
    jsonBody: {
      status: 'ok',
      uptimeSec: Math.round((Date.now() - BOOTED_AT) / 1000),
      oauthTokensCached: oauthTokenCache.size,
      secretsCached: secretCache.size,
      demoMode: DEMO_MODE,
    },
  }),
});
