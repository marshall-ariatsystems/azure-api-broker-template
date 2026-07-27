// credential-scrubber.js — validate + scrub credential-shaped fields (spec §6.3).
//
// Security model: callers MUST NOT supply credentials; this module:
//   1. rejects unambiguous credential-shaped query parameters or body fields
//   2. strips non-allowlisted request headers (allowlist-based, extensible via FORWARD_HEADER_ALLOWLIST)
//   3. redacts credential-shaped fields from vendor responses
//
// Credential-shaped fields are always rejected (not silently dropped) to surface smuggling attempts
// and ensure logging clarity.

const sdk = require('../../sdk');

// The shared set is the canonical base. This local copy is only extended with
// deployment-configured injection names at startup.
const CREDENTIAL_SHAPED_NAMES = new Set(sdk.CREDENTIAL_HEADER_NAMES);

// Bodies and query strings are API data, not credential headers. `key`, `token`, and `client_id`
// are common pagination, lookup, and payload field names, so rejecting them breaks ordinary SDK
// traffic. Keep the strict full set for headers and response redaction; use this narrower set for
// parseable body/query input. Per-vendor policy may add restrictions at the broker boundary.
const CREDENTIAL_PARAMETER_NAMES = new Set([
  'x-api-key', 'api-key', 'apikey', 'api_key', 'authorization', 'access_token', 'subscription-key',
  'x-api-key-id', 'x-api-secret', 'x-key-id', 'x-secret', 'client_secret',
]);

// Headers that are EXPECTED on every legitimate request and must be STRIPPED, never rejected.
//
// `authorization` carries the caller's own Entra token: Easy Auth validates it at the platform and
// still forwards it to the app, so EVERY genuine caller sends it (see clients/call-broker.sh,
// clients/broker_client.py and clients/node/ninja-client.mjs — all shipped callers
// send `Authorization: Bearer <entra-token>`). Treating it as smuggling would 400 all real traffic.
// It is credential-shaped on the VENDOR leg, so it must not be forwarded — but the correct action is
// a silent strip, exactly as the pre-refactor broker did, not a rejection.
//
// `x-ms-*` are Easy Auth's own injected headers (x-ms-client-principal, x-ms-token-aad-*). Same
// reasoning: platform-supplied, always present, must never reach the vendor.
const ALWAYS_STRIP_PREFIXES = ['x-ms-'];
const ALWAYS_STRIP_NAMES = new Set(['authorization']);

function isAlwaysStripped(lowercaseName) {
  return ALWAYS_STRIP_NAMES.has(lowercaseName) ||
         ALWAYS_STRIP_PREFIXES.some((p) => lowercaseName.startsWith(p));
}

// Default forward-allowlist of non-credential headers (spec §6.3).
// Anything not here and not credential-shaped is DROPPED (fail-closed allowlist).
const DEFAULT_HEADER_ALLOWLIST = new Set([
  'accept', 'accept-charset', 'accept-encoding', 'accept-language',
  'content-type', 'user-agent', 'traceparent', 'tracestate', 'x-request-id',
  'if-match', 'if-none-match', 'if-modified-since', 'range', 'idempotency-key',
  'x-correlation-id', 'cache-control', 'prefer', 'accept-version',
]);

// Load extensible header allowlist from FORWARD_HEADER_ALLOWLIST (comma-separated, additive).
function loadHeaderAllowlist() {
  const custom = (process.env.FORWARD_HEADER_ALLOWLIST || '').split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_HEADER_ALLOWLIST, ...custom]);
}

const FORWARD_HEADER_ALLOWLIST = Object.freeze(loadHeaderAllowlist());

// Deployment-configured injection headers are ALWAYS credential-shaped (reject if caller supplies).
// Exported so broker.js can add them to the rejection check.
function addInjectionHeadersToCredentialSet(keyHeaderName, keyIdHeaderName, secretHeaderName) {
  CREDENTIAL_SHAPED_NAMES.add(keyHeaderName.toLowerCase());
  CREDENTIAL_SHAPED_NAMES.add(keyIdHeaderName.toLowerCase());
  CREDENTIAL_SHAPED_NAMES.add(secretHeaderName.toLowerCase());
}

// Check query parameters for credential-shaped names (canonicalized, URL-decoded).
// Returns { ok: true } or { ok: false, field: 'param-name' } (never the value).
function checkQueryParameters(queryString) {
  if (!queryString) return { ok: true };
  // Do NOT pre-decode with decodeURIComponent: URLSearchParams already percent-decodes parameter
  // NAMES, so `%61pi_key` is seen as `api_key` here without help. Pre-decoding is actively harmful —
  // it throws URIError on any malformed sequence (`?a=%`), which a caller can send to turn every
  // request into a 500, and it splits on `&`/`=` that were deliberately encoded as VALUES,
  // manufacturing parameters the caller never sent.
  let params;
  try {
    params = new URLSearchParams(queryString);
  } catch {
    // Unparseable query string: fail closed rather than forwarding something we could not inspect.
    return { ok: false, field: '__query', reason: 'unparseable query string' };
  }
  for (const [key] of params) {
    if (CREDENTIAL_PARAMETER_NAMES.has(key.toLowerCase())) {
      return { ok: false, field: key };
    }
  }
  return { ok: true };
}

// Check request body for credential-shaped fields (JSON and form-urlencoded only).
// Returns { ok: true } or { ok: false, field: 'field-name' } for the first violation.
// For parseable bodies of JSON/form types, returns { ok: false } if unparseable (fail-closed).
function checkRequestBody(bodyBuffer, contentType) {
  if (!bodyBuffer || bodyBuffer.length === 0) return { ok: true };
  if (!contentType) return { ok: true }; // no type, assume safe

  const normalizedType = contentType.split(';')[0].toLowerCase().trim();

  if (normalizedType === 'application/json') {
    let obj;
    try { obj = JSON.parse(bodyBuffer.toString('utf8')); } catch (e) {
      // Unparseable JSON when type is application/json: fail-closed (reject).
      return { ok: false, field: '__body', reason: 'unparseable JSON' };
    }
    const violation = checkObjectRecursive(obj);
    if (violation) return { ok: false, field: violation };
    return { ok: true };
  }

  if (normalizedType === 'application/x-www-form-urlencoded') {
    let form;
    try { form = new URLSearchParams(bodyBuffer.toString('utf8')); } catch (e) {
      // Unparseable form when type is form-urlencoded: fail-closed (reject).
      return { ok: false, field: '__body', reason: 'unparseable form' };
    }
    for (const [key] of form) {
      if (CREDENTIAL_PARAMETER_NAMES.has(key.toLowerCase())) {
        return { ok: false, field: key };
      }
    }
    return { ok: true };
  }

  // Other content types (octet-stream, multipart, etc.) pass through unchanged.
  // Reason: multipart boundaries and binary payloads are complex to parse safely;
  // most vendors that accept credentials do so via headers, query, or JSON — not binary.
  // Logging: the caller can never inject credentials through a safe channel if we've already
  // validated headers and query, so missing body validation for non-standard types is acceptable.
  return { ok: true };
}

// Recursively check an object/array for credential-shaped field names.
// Returns the first violating field name, or null if clean.
function checkObjectRecursive(obj) {
  if (typeof obj !== 'object' || obj === null) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const violation = checkObjectRecursive(item);
      if (violation) return violation;
    }
    return null;
  }
  for (const key of Object.keys(obj)) {
    if (CREDENTIAL_PARAMETER_NAMES.has(key.toLowerCase())) {
      return key;
    }
    const violation = checkObjectRecursive(obj[key]);
    if (violation) return violation;
  }
  return null;
}

// Filter request headers to the allowlist (drop everything else).
// Canonical: lowercase compare, but preserve original casing in output if casing doesn't matter.
// Credential-shaped headers still REJECT (not silently drop) to surface smuggling.
function filterRequestHeaders(incomingHeaders, injectionHeaderNames = []) {
  const outHeaders = {};
  const injectionLower = injectionHeaderNames.map(h => h.toLowerCase());

  for (const [key, value] of incomingHeaders) {
    const lk = key.toLowerCase();

    // Platform-supplied headers (caller's own Entra token, Easy Auth's x-ms-*) are EXPECTED on every
    // legitimate request: strip them silently so they never reach the vendor. Rejecting here would
    // 400 all real traffic. Checked BEFORE the credential test because `authorization` is in both.
    if (isAlwaysStripped(lk)) continue;

    // Connection-scoped headers, including proxy credentials, must never be
    // forwarded. They are platform/proxy residue rather than caller vendor
    // credential attempts, so retain the broker's silent-strip behavior.
    if (sdk.HOP_BY_HOP_HEADER_NAMES.has(lk)) continue;

    // Reject genuinely smuggled credentials (x-api-key, api_key, the deployment-configured injection
    // header names, …). These have no legitimate reason to appear on a caller request, so surfacing
    // them as a 400 is more useful than a silent drop.
    if (CREDENTIAL_SHAPED_NAMES.has(lk) || injectionLower.includes(lk)) {
      return { ok: false, field: key };
    }

    // Keep only allowlisted headers.
    if (FORWARD_HEADER_ALLOWLIST.has(lk)) {
      outHeaders[key] = value;
    }
    // Non-allowlisted, non-credential headers are silently dropped (fail-closed allowlist).
  }
  return { ok: true, headers: outHeaders };
}

// Scrub vendor response headers: remove credential-shaped headers.
function scrubResponseHeaders(incomingHeaders) {
  const outHeaders = {};
  for (const [key, value] of incomingHeaders) {
    if (!CREDENTIAL_SHAPED_NAMES.has(key.toLowerCase())) {
      outHeaders[key] = value;
    }
  }
  return outHeaders;
}

// Scrub vendor response body: redact credential-shaped fields in JSON (recursive).
// Returns { buffer, modified } (original buffer if not JSON or no violations).
function scrubResponseBody(bodyBuffer, contentType) {
  if (!bodyBuffer || bodyBuffer.length === 0) return { buffer: bodyBuffer, modified: false };
  if (!contentType) return { buffer: bodyBuffer, modified: false };

  const normalizedType = contentType.split(';')[0].toLowerCase().trim();
  if (normalizedType !== 'application/json') return { buffer: bodyBuffer, modified: false };

  let obj;
  try { obj = JSON.parse(bodyBuffer.toString('utf8')); } catch (e) {
    // If response is not valid JSON (despite claiming it is), pass through unchanged.
    return { buffer: bodyBuffer, modified: false };
  }

  const scrubbed = scrubObjectRecursive(obj);
  if (!scrubbed.modified) return { buffer: bodyBuffer, modified: false };

  // Rebuild JSON, byte-preserving where possible (goal: minimize surprises in response parsing).
  return { buffer: Buffer.from(JSON.stringify(scrubbed.obj)), modified: true };
}

// Recursively redact credential-shaped field values (replace with "[redacted]").
// Returns { obj: scrubbed, modified: bool }.
function scrubObjectRecursive(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return { obj, modified: false };
  }
  if (Array.isArray(obj)) {
    let modified = false;
    const scrubbed = obj.map((item) => {
      const result = scrubObjectRecursive(item);
      if (result.modified) modified = true;
      return result.obj;
    });
    return { obj: scrubbed, modified };
  }

  let modified = false;
  const scrubbed = {};
  for (const [key, value] of Object.entries(obj)) {
    if (CREDENTIAL_SHAPED_NAMES.has(key.toLowerCase())) {
      scrubbed[key] = '[redacted]';
      modified = true;
    } else {
      const result = scrubObjectRecursive(value);
      scrubbed[key] = result.obj;
      if (result.modified) modified = true;
    }
  }
  return { obj: scrubbed, modified };
}

module.exports = {
  checkQueryParameters,
  checkRequestBody,
  filterRequestHeaders,
  scrubResponseHeaders,
  scrubResponseBody,
  addInjectionHeadersToCredentialSet,
  CREDENTIAL_SHAPED_NAMES,
  CREDENTIAL_PARAMETER_NAMES,
  FORWARD_HEADER_ALLOWLIST,
};
