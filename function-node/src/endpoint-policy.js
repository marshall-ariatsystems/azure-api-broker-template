'use strict';

// endpoint-policy.js — per-endpoint (path + method) lockdown for a broker connection.
//
// Goal: let an operator lock down which vendor endpoints a role may reach, server-side, and
// change it at runtime. The policy rides on the ROLE_SECRET_MAP entry as an optional `endpoints`
// object, so it flows through the same App Configuration hot-reload path as grants and role maps —
// a tightened lockdown is effective on the next call, with no redeploy and no key rotation.
//
// Grammar (on a role-map entry):
//   "endpoints": {
//     "mode": "allow",                                  // "allow" = default-deny (only listed pass)
//                                                        // "deny"  = default-allow (listed blocked)
//     "rules": [
//       { "methods": ["POST"], "path": "/v1/chat/completions" },
//       { "path": "/v1/models", "prefix": true },        // prefix match
//       { "path": "/v1/embeddings" }                     // any method, exact path
//     ]
//   }
//
// Fail-closed by construction:
//   - No `endpoints` field           -> null policy -> connection is unrestricted (back-compat).
//   - Malformed `endpoints`          -> normalizeEndpointPolicy throws; the caller treats that as
//                                        a closed gate (deny), never as "unrestricted".
//   - mode "allow" and nothing matches -> denied.

const MAX_RULES = 256;
const MAX_PATH = 2048;
const KNOWN_POLICY_KEYS = new Set(['mode', 'rules']);
const KNOWN_RULE_KEYS = new Set(['methods', 'path', 'prefix']);

function fail(message) {
  throw new TypeError(message);
}

function rejectUnknownKeys(value, allowed, message) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(message);
}

// Normalize a caller subpath to a leading-slash, query-free comparison key. The broker passes the
// vendor-native subpath with the vendor slug already stripped and the query already separated.
function normalizePath(subpath) {
  const raw = typeof subpath === 'string' ? subpath : '';
  const noQuery = raw.split('?')[0].split('#')[0];
  const withSlash = noQuery.startsWith('/') ? noQuery : `/${noQuery}`;
  // Collapse duplicate slashes so "/v1//models" cannot dodge an exact-match rule.
  return withSlash.replace(/\/{2,}/g, '/');
}

// Parse + validate an `endpoints` object into a frozen policy. Returns null when the connection
// declares no endpoint policy (unrestricted). Throws TypeError on any malformed shape.
function normalizeEndpointPolicy(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('endpoint policy is invalid');
  rejectUnknownKeys(raw, KNOWN_POLICY_KEYS, 'endpoint policy is invalid');

  const mode = raw.mode;
  if (mode !== 'allow' && mode !== 'deny') fail('endpoint policy mode must be "allow" or "deny"');

  if (!Array.isArray(raw.rules) || raw.rules.length === 0 || raw.rules.length > MAX_RULES) {
    fail('endpoint policy requires 1..256 rules');
  }

  const rules = raw.rules.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('endpoint rule is invalid');
    rejectUnknownKeys(entry, KNOWN_RULE_KEYS, 'endpoint rule is invalid');
    if (typeof entry.path !== 'string' || !entry.path || entry.path.length > MAX_PATH) fail('endpoint rule path is invalid');
    const prefix = entry.prefix === undefined ? false : entry.prefix;
    if (typeof prefix !== 'boolean') fail('endpoint rule prefix must be boolean');

    let methods = null;
    if (entry.methods !== undefined) {
      if (!Array.isArray(entry.methods) || entry.methods.length === 0) fail('endpoint rule methods is invalid');
      methods = entry.methods.map((method) => {
        if (typeof method !== 'string' || !method) fail('endpoint rule method is invalid');
        return method.toUpperCase();
      });
    }
    return Object.freeze({ path: normalizePath(entry.path), prefix, methods: methods ? Object.freeze(methods) : null });
  });

  return Object.freeze({ mode, rules: Object.freeze(rules) });
}

function ruleMatches(rule, method, path) {
  if (rule.methods && !rule.methods.includes(method)) return false;
  return rule.prefix ? path.startsWith(rule.path) : path === rule.path;
}

// Evaluate a request against a normalized policy. A null policy is unrestricted (allow). Anything
// other than a normalized policy object (e.g. a value that slipped past validation) is fail-closed.
function evaluateEndpointPolicy(policy, { method, subpath } = {}) {
  if (policy === null || policy === undefined) return { allowed: true, reason: 'unrestricted' };
  if (typeof policy !== 'object' || (policy.mode !== 'allow' && policy.mode !== 'deny') || !Array.isArray(policy.rules)) {
    return { allowed: false, reason: 'endpoint policy malformed' };
  }
  const normalizedMethod = String(method || '').toUpperCase();
  const path = normalizePath(subpath);
  const matched = policy.rules.some((rule) => ruleMatches(rule, normalizedMethod, path));
  if (policy.mode === 'allow') {
    return matched ? { allowed: true, reason: 'allow-listed' } : { allowed: false, reason: 'not on allow-list' };
  }
  return matched ? { allowed: false, reason: 'deny-listed' } : { allowed: true, reason: 'not on deny-list' };
}

module.exports = { normalizeEndpointPolicy, evaluateEndpointPolicy, normalizePath };
