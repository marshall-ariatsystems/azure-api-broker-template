/**
 * Parse a rate-limit delay without exposing the HTTP response itself.
 *
 * @param {{ headers?: { get?: (name: string) => unknown } }} response
 * @param {{ defaultRetryAfterSeconds: number }} policy
 * @returns {number}
 */
export function parseRetryAfter(response, { defaultRetryAfterSeconds }) {
  const rawValue = response?.headers?.get?.('retry-after');
  const parsed = typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())
    ? Number.parseInt(rawValue.trim(), 10)
    : Number.NaN;

  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  return defaultRetryAfterSeconds;
}

function rateLimitSurface(response, retryAfterSeconds, attempts) {
  return {
    status: response.status,
    retryAfterSeconds,
    correlationId: response.headers?.get?.('x-correlation-id') ?? null,
    attempts,
  };
}

function boundedJitter(jitter, ceilingMs) {
  const candidate = jitter.next(ceilingMs);
  if (!Number.isFinite(candidate)) return 0;
  return Math.max(0, Math.min(candidate, ceilingMs));
}

/**
 * Apply the broker's rate-limit retry contract through entirely injected seams.
 *
 * @param {object} options
 * @param {() => Promise<{status: number, headers?: {get?: (name: string) => unknown}}>} options.doFetch
 * @param {{idempotent?: boolean, idempotencyKey?: string}} options.request
 * @param {{maxRetries: number, jitterCeilingMs: number, defaultRetryAfterSeconds: number}} options.policy
 * @param {{sleep: (milliseconds: number) => Promise<void>}} options.clock
 * @param {{next: (ceilingMs: number) => number}} options.jitter
 * @param {undefined | (() => Promise<string>)} options.checkExecutionStatus
 */
export async function requestWithRetry({
  doFetch,
  request,
  policy,
  clock,
  jitter,
  checkExecutionStatus,
}) {
  let attempts = 0;
  let writeRetryUsed = false;
  let lastRetryAfterSeconds = null;

  while (true) {
    const response = await doFetch();
    attempts += 1;

    if (response.status !== 429) return rateLimitSurface(response, lastRetryAfterSeconds, attempts);

    const retryAfterSeconds = parseRetryAfter(response, policy);
    lastRetryAfterSeconds = retryAfterSeconds;
    const surface = rateLimitSurface(response, retryAfterSeconds, attempts);
    const isIdempotentRead = request.idempotent === true;
    const hasWriteRetryContract = Boolean(request.idempotencyKey) && typeof checkExecutionStatus === 'function';

    let mayRetry = isIdempotentRead && attempts <= policy.maxRetries;
    if (!isIdempotentRead && !writeRetryUsed && hasWriteRetryContract) {
      const executionStatus = await checkExecutionStatus();
      mayRetry = executionStatus === 'not-executed';
      writeRetryUsed = mayRetry;
    }

    if (!mayRetry) return surface;

    await clock.sleep(retryAfterSeconds * 1000 + boundedJitter(jitter, policy.jitterCeilingMs));
  }
}
