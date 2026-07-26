import { compatibilityEnvironment, PRESET_NAMES } from '../../broker-adapters/presets.mjs';

export const PRESETS = new Set(PRESET_NAMES);
export { compatibilityEnvironment };

export function usage() {
  return `Usage:
  broker-bridge serve --broker <https-discovery-url-with-public-oidc-bootstrap>
  broker-bridge run --broker <https-discovery-url-with-public-oidc-bootstrap> [--preset openai|anthropic|generic] [--set NAME=VALUE] -- <application> [args...]
  broker-bridge --version

Broker discovery and login state exist only for this run and are never written locally.`;
}

export function validateBrokerDiscoveryUrl(value) {
  if (typeof value !== 'string' || !value) throw new Error('`--broker <https-discovery-url>` is required.');
  let url;
  try { url = new URL(value); } catch { throw new Error('`--broker` must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('`--broker` must be an HTTPS URL without credentials, fragments, or a non-default port.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}

// Public OIDC configuration is intentionally data-only: no local secret, refresh grant, or
// token storage is accepted. This remains exported for embedding/config-file users.
export function parseOidcConfiguration(environment = process.env) {
  const mode = environment.BROKER_AUTH_MODE;
  if (mode !== 'oidc') throw new Error('BROKER_AUTH_MODE must be oidc.');
  const prohibited = Object.keys(environment).find((key) => /client.?secret|password|private.?key|token|refresh/i.test(key) && environment[key]);
  if (prohibited) throw new Error('OIDC configuration contains prohibited credential material.');
  const issuer = environment.OIDC_ISSUER; const clientId = environment.OIDC_CLIENT_ID; const scope = environment.OIDC_SCOPE;
  if (!issuer || !clientId || !scope || !scope.split(/\s+/).includes('openid') || scope.split(/\s+/).includes('offline_access')) throw new Error('OIDC configuration is invalid.');
  const audienceParameter = environment.OIDC_AUDIENCE_PARAMETER;
  if (audienceParameter && !['audience', 'resource'].includes(audienceParameter)) throw new Error('OIDC audience parameter is invalid.');
  if (!validateBrokerDiscoveryUrl(environment.BROKER_BASE || '')) throw new Error('Broker base must be HTTPS.');
  return Object.freeze({ mode, issuer, clientId, scope, ...(audienceParameter ? { audienceParameter } : {}) });
}

function parseBroker(args, options) {
  if (args[0] !== '--broker' || args[1] === undefined) return { error: '`--broker <https-discovery-url>` is required.' };
  try { options.brokerDiscoveryUrl = validateBrokerDiscoveryUrl(args[1]); } catch (error) { return { error: error.message }; }
  return null;
}

export function parseCli(argv) {
  if (argv[0] === '--version' || argv[0] === '-v') return { command: 'version' };
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return { command: 'help' };
  if (argv[0] === 'serve') {
    const options = { command: 'serve', host: '127.0.0.1', port: 8079 };
    const error = parseBroker(argv.slice(1), options);
    if (error) return error;
    if (argv.length !== 3) return { error: '`serve` accepts only `--broker <https-discovery-url>`.' };
    return Object.freeze(options);
  }
  if (argv[0] !== 'run') return { error: argv.length ? `Unknown command '${argv[0]}'.` : '`serve` or `run` is required.' };

  const options = { command: 'run', host: '127.0.0.1', port: 8079, preset: undefined, mappings: [], application: [] };
  const brokerError = parseBroker(argv.slice(1), options);
  if (brokerError) return brokerError;
  let i = 3;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { options.application = argv.slice(i + 1); break; }
    if (arg === '--preset' || arg === '--set') {
      const value = argv[++i];
      if (value === undefined) return { error: `Option '${arg}' requires a value.` };
      if (arg === '--preset') options.preset = value;
      else options.mappings.push(value);
      continue;
    }
    return { error: `Unknown run option '${arg}'.` };
  }
  if (!options.application.length) return { error: '`run` requires an application after `--`.' };
  if (options.preset !== undefined && !PRESETS.has(options.preset)) return { error: `Unsupported preset '${options.preset}'. Choose: ${[...PRESETS].join(', ')}.` };
  return Object.freeze(options);
}
