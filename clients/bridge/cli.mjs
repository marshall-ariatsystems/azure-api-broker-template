import { appendFile, lstat, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { compatibilityEnvironment, PRESET_NAMES } from '../../broker-adapters/presets.mjs';
import { validateRoutingMode } from './routing.mjs';

export const PRESETS = new Set(PRESET_NAMES);
export { compatibilityEnvironment };

export function usage() {
  return `Usage:
  broker-bridge init [--preset openai|anthropic|generic] [--output broker.env] [--append-dotenv]
  broker-bridge serve [--config broker.env]
  broker-bridge run [--config broker.env] [--preset openai|anthropic|generic] [--set NAME=VALUE] -- <application> [args...]
  broker-bridge --version

init creates keyless broker configuration. It never asks for or writes a vendor API key.`;
}

export function parseCli(argv) {
  if (argv.length === 0) return { command: 'serve' }; // Backward compatible with npm start.
  if (argv[0] === '--version' || argv[0] === '-v') return { command: 'version' };
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return { command: 'help' };
  if (argv[0] === 'serve') {
    if (argv.length === 1) return { command: 'serve' };
    if (argv.length === 3 && argv[1] === '--config') return { command: 'serve', config: argv[2] };
    return { error: '`serve` accepts only `--config <path>`.' };
  }
  if (argv[0] === 'run') {
    const options = { command: 'run', config: 'broker.env', preset: undefined, mappings: [], application: [] };
    let i = 1;
    for (; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--') {
        options.application = argv.slice(i + 1);
        break;
      }
      if (arg === '--config') options.config = argv[++i];
      else if (arg === '--preset') options.preset = argv[++i];
      else if (arg === '--set') options.mappings.push(argv[++i]);
      else return { error: `Unknown run option '${arg}'.` };
      if (options.config === undefined || options.preset === undefined && arg === '--preset' || options.mappings.at(-1) === undefined && arg === '--set') {
        return { error: `Option '${arg}' requires a value.` };
      }
    }
    if (!options.application.length) return { error: '`run` requires an application after `--`.' };
    if (options.preset !== undefined && !PRESETS.has(options.preset)) {
      return { error: `Unsupported preset '${options.preset}'. Choose: ${[...PRESETS].join(', ')}.` };
    }
    return options;
  }
  if (argv[0] !== 'init') return { error: `Unknown command '${argv[0]}'.` };

  const options = { command: 'init', preset: 'generic', output: 'broker.env', appendDotenv: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--preset') options.preset = argv[++i];
    else if (arg === '--output') options.output = argv[++i];
    else if (arg === '--append-dotenv') options.appendDotenv = true;
    else return { error: `Unknown init option '${arg}'.` };
    if (options.preset === undefined || options.output === undefined) {
      return { error: `Option '${arg}' requires a value.` };
    }
  }
  if (!PRESETS.has(options.preset)) {
    return { error: `Unsupported preset '${options.preset}'. Choose: ${[...PRESETS].join(', ')}.` };
  }
  return options;
}

export function renderBridgeEnv(preset) {
  return `# Broker Bridge configuration — no vendor API key belongs in this file.\n` +
    `# Fill in these values from the broker deployment outputs.\n` +
    `BROKER_BASE=https://<broker-host>/api/broker\n` +
    `BROKER_SCOPE=api://<broker-app-id>/.default\n` +
    `BROKER_VENDOR=${preset}\n` +
    `# strict is the secure default. Use named only when the broker explicitly enables multi-role routing.\n` +
    `BROKER_ROUTING_MODE=strict\n`;
}

export function parseEnv(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let [, key, value] = match;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function loadBridgeConfig({ cwd = process.cwd(), config = 'broker.env', environment = process.env } = {}) {
  const configPath = resolve(cwd, config);
  let fileValues;
  try {
    fileValues = parseEnv(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Broker configuration not found: ${config}. Run \`broker-bridge init\` first or pass \`serve --config <path>\`.`);
    }
    throw error;
  }

  const values = { ...fileValues, ...Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)) };
  const brokerBase = (values.BROKER_BASE ?? '').replace(/\/+$/, '');
  const brokerScope = values.BROKER_SCOPE ?? '';
  const vendor = values.BROKER_VENDOR ?? 'generic';
  const routingMode = validateRoutingMode(values.BROKER_ROUTING_MODE);
  const host = values.BRIDGE_HOST ?? '127.0.0.1';
  const port = Number(values.BRIDGE_PORT ?? '8079');

  if (!brokerBase || !brokerScope) {
    throw new Error('BROKER_BASE and BROKER_SCOPE are required. Fill them in broker.env from the broker deployment outputs.');
  }
  if (!/^https:\/\//i.test(brokerBase)) throw new Error('BROKER_BASE must be an HTTPS URL.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(vendor)) throw new Error('BROKER_VENDOR must be a vendor slug, not a URL or credential.');
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('BRIDGE_HOST must remain loopback-only (127.0.0.1, ::1, or localhost).');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BRIDGE_PORT must be an integer from 1 through 65535.');

  return { brokerBase, brokerScope, vendor, routingMode, host, port, configPath };
}

function dotenvBlock(contents) {
  return `\n# >>> broker-bridge >>>\n${contents}# <<< broker-bridge <<<\n`;
}

function hasBrokerSettings(contents) {
  return /(^|\n)\s*(?:export\s+)?BROKER_(?:BASE|SCOPE|VENDOR|ROUTING_MODE)\s*=/.test(contents) ||
    contents.includes('# >>> broker-bridge >>>');
}

async function pathInfo(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function initializeBridge({ cwd = process.cwd(), preset = 'generic', output = 'broker.env', appendDotenv = false } = {}) {
  if (!PRESETS.has(preset)) throw new Error(`Unsupported preset '${preset}'.`);
  const outputPath = resolve(cwd, output);
  const dotenvPath = resolve(cwd, '.env');
  if (outputPath === dotenvPath) throw new Error('`--output .env` is not supported; keep broker.env as the source of truth.');
  const dotenv = await pathInfo(dotenvPath);
  if (dotenv && !dotenv.isSymbolicLink() && appendDotenv) {
    const existingDotenv = await readFile(dotenvPath, 'utf8');
    if (hasBrokerSettings(existingDotenv)) {
      throw new Error('.env already contains Broker Bridge settings; refusing to append duplicates.');
    }
  }

  const contents = renderBridgeEnv(preset);
  try {
    await writeFile(outputPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${output} already exists; refusing to overwrite it.`);
    throw error;
  }

  console.log('Next steps:');
  console.log('BROKER_BASE and BROKER_SCOPE come from your broker deployment: Function App URL and App ID URI; ask the deploying admin or see identity/outputs.json.');
  console.log('For how the scope exists, see identity/app-registration.md.');
  console.log('For how a developer gets the app role, see identity/grant-revoke-runbook.md.');

  if (!dotenv) {
    try {
      // A relative link survives moving the project directory as a unit.
      await symlink(relative(dirname(dotenvPath), outputPath), dotenvPath);
      return { outputPath, dotenv: 'linked' };
    } catch (error) {
      // Keep the generated config. Windows may require Developer Mode or elevated permission for links.
      return { outputPath, dotenv: 'not-linked', reason: error?.code ?? 'link-failed' };
    }
  }

  if (dotenv.isSymbolicLink()) {
    const target = resolve(dirname(dotenvPath), await readlink(dotenvPath));
    if (target === outputPath) return { outputPath, dotenv: 'already-linked' };
    return { outputPath, dotenv: 'existing-symlink' };
  }

  if (!appendDotenv) return { outputPath, dotenv: 'existing-file' };
  await appendFile(dotenvPath, dotenvBlock(contents), { encoding: 'utf8' });
  return { outputPath, dotenv: 'appended' };
}
