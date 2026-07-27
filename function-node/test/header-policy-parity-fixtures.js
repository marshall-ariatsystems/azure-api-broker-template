'use strict';
// The union sensitive-header corpus both boundaries must block, plus benign headers both must forward.
// CREDENTIAL: caller-supplied credential delivery names (union of the prior bridge + broker sets).
const CREDENTIAL_HEADER_FIXTURES = Object.freeze([
  'authorization', 'x-api-key', 'api-key', 'apikey', 'api_key', 'subscription-key',
  'access_token', 'token', 'client_id', 'client_secret', 'x-api-secret', 'x-key-id',
  'x-secret', 'key', 'x-api-key-id',
]);
// HOP_BY_HOP: RFC 7230 connection-scoped names, now INCLUDING the two proxy headers (H6 gap).
const HOP_BY_HOP_HEADER_FIXTURES = Object.freeze([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length',
  'proxy-authorization', 'proxy-authenticate',
]);
// The two names that were blocked by NEITHER boundary before this ED.
const PROXY_HEADER_FIXTURES = Object.freeze(['proxy-authorization', 'proxy-authenticate']);
// Case variants — every sensitive name must block regardless of case.
const CASE_VARIANTS = Object.freeze(['Authorization', 'AUTHORIZATION', 'Proxy-Authorization', 'PROXY-AUTHENTICATE', 'X-Api-Key']);
// Benign headers both boundaries must forward (never blocked).
const BENIGN_HEADER_FIXTURES = Object.freeze(['accept', 'content-type', 'user-agent', 'traceparent', 'x-request-id']);
module.exports = Object.freeze({
  CREDENTIAL_HEADER_FIXTURES, HOP_BY_HOP_HEADER_FIXTURES, PROXY_HEADER_FIXTURES,
  CASE_VARIANTS, BENIGN_HEADER_FIXTURES,
});
