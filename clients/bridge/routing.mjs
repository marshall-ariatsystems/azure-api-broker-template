const ROUTING_MODES = new Set(['strict', 'named']);

export function validateRoutingMode(value) {
  const mode = value ?? 'strict';
  if (!ROUTING_MODES.has(mode)) {
    throw new Error('BROKER_ROUTING_MODE must be either `strict` or `named`.');
  }
  return mode;
}

/**
 * Convert a local compatibility URL into the path understood by the approved
 * broker.  Strict mode deliberately consumes the configured vendor slug: the
 * broker then authorizes its one assigned role and sees the vendor-native path.
 * Named mode preserves the slug for brokers that have explicitly enabled
 * multi-role vendor routing.
 */
export function routeBrokerPath(localPathname, { vendor, routingMode }) {
  const segments = localPathname.split('/').filter(Boolean);
  const requestedVendor = segments.shift();
  if (!requestedVendor) {
    throw new Error('path must start with a vendor slug: /<vendor>/<vendor-path>');
  }

  if (routingMode === 'strict') {
    if (requestedVendor.toLowerCase() !== vendor.toLowerCase()) {
      throw new Error(`local vendor slug '${requestedVendor}' does not match configured BROKER_VENDOR='${vendor}'.`);
    }
    return segments.join('/');
  }

  return [requestedVendor, ...segments].join('/');
}

