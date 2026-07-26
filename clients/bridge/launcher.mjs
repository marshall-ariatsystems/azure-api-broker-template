import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForHealth(url, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child may still be binding its loopback listener.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Bridge health check timed out after ${timeoutMs}ms: ${url}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = childExit(child);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
  try { await exited; } finally { clearTimeout(timeout); }
}

export function exitCodeForSignal(signal) {
  return ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[signal] ?? 1;
}

export async function runApplication({
  application,
  configPath,
  cwd = process.cwd(),
  environment = process.env,
  compatibilityEnv,
  host,
  port,
  bridgeScript = fileURLToPath(new URL('./broker-bridge.mjs', import.meta.url)),
  healthTimeoutMs,
}) {
  const bridge = spawn(process.execPath, [bridgeScript, 'serve', '--config', configPath], {
    cwd,
    env: environment,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let app;
  let rejectInterrupt;
  const interrupted = new Promise((_, reject) => { rejectInterrupt = reject; });
  const forwardSignal = (signal) => {
    app?.kill(signal);
    bridge.kill(signal);
    const error = new Error(`Interrupted by ${signal}.`);
    error.signal = signal;
    rejectInterrupt(error);
  };
  const onSigint = () => forwardSignal('SIGINT');
  const onSigterm = () => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    const healthHost = host === '::1' ? '[::1]' : host;
    await Promise.race([waitForHealth(`http://${healthHost}:${port}/_bridge/health`, { timeoutMs: healthTimeoutMs }), interrupted]);
    app = spawn(application[0], application.slice(1), {
      cwd,
      env: { ...environment, ...compatibilityEnv },
      stdio: 'inherit',
    });
    const result = await Promise.race([childExit(app), interrupted]);
    return result.code ?? exitCodeForSignal(result.signal);
  } catch (error) {
    if (error.signal) return exitCodeForSignal(error.signal);
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    await stop(bridge);
  }
}

export { waitForHealth };
