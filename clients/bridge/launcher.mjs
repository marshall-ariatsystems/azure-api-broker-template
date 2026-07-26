import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INHERITED_ENVIRONMENT_KEYS = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL']);

export function inheritedEnvironment(environment = process.env) {
  return Object.fromEntries(INHERITED_ENVIRONMENT_KEYS.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]));
}

function childExit(child) { return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
export async function waitForHealth(url, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, intervalMs)); }
  throw new Error(`Bridge health check timed out after ${timeoutMs}ms: ${url}`);
}
async function stop(child) { if (!child || child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGTERM'); const exited = childExit(child); const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000); try { await exited; } finally { clearTimeout(timeout); } }
export function exitCodeForSignal(signal) { return ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[signal] ?? 1; }

export async function runApplication({ application, brokerDiscoveryUrl, cwd = process.cwd(), environment = process.env, compatibilityEnv, port = 8079, bridgeScript = import.meta.url ? fileURLToPath(new URL('./broker-bridge.mjs', import.meta.url)) : process.argv[1], healthTimeoutMs, bridgeAlreadyRunning = false }) {
  let sea = false; try { sea = (await import('node:sea')).isSea(); } catch {}
  const bridge = bridgeAlreadyRunning ? undefined : spawn(process.execPath, sea ? ['serve', '--broker', brokerDiscoveryUrl] : [bridgeScript, 'serve', '--broker', brokerDiscoveryUrl], { cwd, env: inheritedEnvironment(environment), stdio: ['ignore', 'inherit', 'inherit'] });
  let app; let rejectInterrupt;
  const interrupted = new Promise((_, reject) => { rejectInterrupt = reject; });
  const forwardSignal = (signal) => { app?.kill(signal); bridge?.kill(signal); const error = new Error(`Interrupted by ${signal}.`); error.signal = signal; rejectInterrupt(error); };
  const onSigint = () => forwardSignal('SIGINT'); const onSigterm = () => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);
  try {
    await Promise.race([waitForHealth(`http://127.0.0.1:${port}/_bridge/health`, { timeoutMs: healthTimeoutMs }), interrupted]);
    app = spawn(application[0], application.slice(1), { cwd, env: { ...inheritedEnvironment(environment), ...compatibilityEnv }, stdio: 'inherit' });
    const result = await Promise.race([childExit(app), interrupted]); return result.code ?? exitCodeForSignal(result.signal);
  } catch (error) { if (error.signal) return exitCodeForSignal(error.signal); throw error; }
  finally { process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm); await stop(bridge); }
}
