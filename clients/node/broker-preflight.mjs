const apiScopePattern = /^api:\/\/[^/\s]+\/.+$/;

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

/** Load the non-secret broker settings used by the preflight adapter. */
export function loadBrokerConfig(env = process.env) {
  const rawBase = required(env, 'BROKER_BASE');
  const scope = required(env, 'BROKER_SCOPE');

  let parsed;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new Error('BROKER_BASE must be an HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('BROKER_BASE must be an HTTPS URL');
  }
  if ((scope.startsWith('api://') && !apiScopePattern.test(scope)) || (!scope.startsWith('api://') && /\s/.test(scope))) {
    throw new Error('BROKER_SCOPE is malformed');
  }

  return { base: rawBase.replace(/\/+$/, ''), scope };
}

/**
 * Acquire a token and invoke an authenticated preflight through injected seams.
 * Deliberately return only the safe response fields.
 */
export async function runPreflight({ config, acquireToken, invokePreflight }) {
  const token = await acquireToken();
  const response = await invokePreflight(config.base, token);
  return { status: response.status, correlationId: response.correlationId };
}
