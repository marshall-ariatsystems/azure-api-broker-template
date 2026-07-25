// These are caller-controlled credential delivery headers.  The local bridge
// authenticates itself to the broker and must never relay a client credential.
const CREDENTIAL_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'apikey', 'api_key',
  'subscription-key', 'access_token', 'token',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length',
]);

export function isBlockedRequestHeader(name) {
  const normalized = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(normalized) ||
    CREDENTIAL_HEADERS.has(normalized) ||
    normalized.startsWith('x-ms-');
}

export function brokerRequestHeaders(headers, brokerToken) {
  const forwarded = { authorization: `Bearer ${brokerToken}` };
  for (const [name, value] of Object.entries(headers)) {
    if (!isBlockedRequestHeader(name)) forwarded[name] = value;
  }
  return forwarded;
}

export { CREDENTIAL_HEADERS, HOP_BY_HOP_HEADERS };
