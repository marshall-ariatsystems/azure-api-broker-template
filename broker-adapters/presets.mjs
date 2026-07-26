// Provider-neutral application compatibility presets.  Values are derived at
// runtime; this module never reads or stores a vendor credential.
export const PRESET_NAMES = Object.freeze(['openai', 'anthropic', 'generic']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function localBridgeBase({ vendor, host, port }) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('Adapter URLs must use a loopback host.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(vendor)) throw new Error('Adapter vendor must be a slug.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Adapter port must be valid.');
  return `http://${host === '::1' ? '[::1]' : host}:${port}/${vendor}`;
}

export function compatibilityEnvironment({ preset, vendor, host, port, mappings = [] }) {
  const chosenPreset = preset ?? vendor;
  if (!PRESET_NAMES.includes(chosenPreset)) {
    throw new Error(`No compatibility preset for '${chosenPreset}'. Pass --preset openai, anthropic, or generic.`);
  }
  const localBase = localBridgeBase({ vendor, host, port });
  const presetValues = {
    openai: { OPENAI_BASE_URL: `${localBase}/v1`, OPENAI_API_KEY: 'broker-managed' },
    anthropic: { ANTHROPIC_BASE_URL: localBase, ANTHROPIC_API_KEY: 'broker-managed' },
    generic: { VENDOR_BASE_URL: localBase, VENDOR_API_KEY: 'broker-managed' },
  }[chosenPreset];

  const explicit = {};
  for (const mapping of mappings) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(mapping ?? '');
    if (!match) throw new Error('`--set` requires NAME=VALUE.');
    const [, name, value] = match;
    if (value !== 'broker-managed' && value !== localBase && value !== `${localBase}/v1`) {
      throw new Error('`--set` values must be a bridge loopback URL or the `broker-managed` placeholder.');
    }
    explicit[name] = value;
  }
  return { ...presetValues, ...explicit };
}
