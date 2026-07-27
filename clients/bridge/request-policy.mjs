import sdk from '../../sdk/index.js';

// The local bridge authenticates itself to the broker and must never relay a
// client credential. These aliases preserve the public module surface while
// sourcing membership from the shared SDK policy.
const CREDENTIAL_HEADERS = sdk.CREDENTIAL_HEADER_NAMES;
const HOP_BY_HOP_HEADERS = sdk.HOP_BY_HOP_HEADER_NAMES;

export function isBlockedRequestHeader(name) {
  return sdk.isBlockedRequestHeader(name);
}

export function brokerRequestHeaders(headers, brokerToken) {
  const forwarded = { authorization: `Bearer ${brokerToken}` };
  for (const [name, value] of Object.entries(headers)) {
    if (!isBlockedRequestHeader(name)) forwarded[name] = value;
  }
  return forwarded;
}

export { CREDENTIAL_HEADERS, HOP_BY_HOP_HEADERS };
