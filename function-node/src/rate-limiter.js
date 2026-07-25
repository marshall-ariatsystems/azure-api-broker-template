// rate-limiter.js — distributed per-caller + per-key quota enforcement (spec §9).
//
// Design: Fixed-window per-minute counters backed by Azure Table Storage, with optimistic
// concurrency control to avoid lost updates on 412 (concurrent write) conflicts.
//
// Caller quota = per unique oid (object id from principal)
// Key quota = per unique secret name
// Each violation is independent: key rejection does NOT consume caller budget.

const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');

const QUOTA_CALLER_PER_MIN = parseInt(process.env.QUOTA_CALLER_PER_MIN || '60', 10);
const QUOTA_KEY_PER_MIN = parseInt(process.env.QUOTA_KEY_PER_MIN || '600', 10);
const RATE_LIMIT_TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME || 'brokerRateLimits';
const RATE_LIMIT_FAIL_MODE = (process.env.RATE_LIMIT_FAIL_MODE || 'closed').toLowerCase(); // closed | open
// Storage account hosting the counter table. Managed identity only — the broker's whole premise is
// that no long-lived secret exists in app settings, so a connection string / account key here would
// contradict the design. Set RATE_LIMIT_STORAGE_ACCOUNT to the account NAME; the endpoint is derived.
// (AzureWebJobsStorage is deliberately NOT reused: on Flex Consumption it is identity-based and may
// be blank, and parsing an account key out of it would reintroduce the secret we are trying to avoid.)
const RATE_LIMIT_STORAGE_ACCOUNT = process.env.RATE_LIMIT_STORAGE_ACCOUNT;
const RATE_LIMIT_TABLE_ENDPOINT = process.env.RATE_LIMIT_TABLE_ENDPOINT ||
  (RATE_LIMIT_STORAGE_ACCOUNT ? `https://${RATE_LIMIT_STORAGE_ACCOUNT}.table.core.windows.net` : null);

let tableClient = null;
let initError = null;

// Lazy-init Table Storage client on first quota check.
// Errors are captured at init time so they propagate through quotaCheck() clearly.
async function getTableClient() {
  if (tableClient) return tableClient;
  if (initError) throw initError;

  try {
    if (!RATE_LIMIT_TABLE_ENDPOINT) {
      initError = new Error(
        'RATE_LIMIT_STORAGE_ACCOUNT (or RATE_LIMIT_TABLE_ENDPOINT) not configured; Table Storage is required for quota enforcement',
      );
      throw initError;
    }
    // Same managed identity the broker already uses for Key Vault (spec §7). Requires the
    // "Storage Table Data Contributor" role on the counter storage account.
    const client = new TableClient(
      RATE_LIMIT_TABLE_ENDPOINT,
      RATE_LIMIT_TABLE_NAME,
      new DefaultAzureCredential(),
    );
    // Ensure the table exists (idempotent; TableAlreadyExists is the expected steady-state result).
    try {
      await client.createTable();
    } catch (e) {
      if (e?.statusCode !== 409 && e?.code !== 'TableAlreadyExists') throw e;
    }
    tableClient = client;
    return tableClient;
  } catch (e) {
    initError = e;
    throw initError;
  }
}

// Seconds remaining in the current fixed minute window. The issue requires a MEANINGFUL Retry-After,
// so this is computed from the clock rather than returning a flat 60 that tells the caller nothing.
function secondsUntilWindowRollover(now = new Date()) {
  return 60 - now.getUTCSeconds();
}

// Jittered backoff between optimistic-concurrency attempts (50-150ms).
function backoff() {
  return new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
}

// Increment-and-check a counter: read current, increment, write back with ETa g conflict retry.
// On 412 (ETag mismatch), retry up to 3 times with backoff (optimistic concurrency).
// Returns { allowed: bool, retryAfterSeconds: number }.
async function incrementAndCheckWithRetry(
  partitionKey,
  rowKey,
  limit,
  maxRetries = 3,
) {
  const client = await getTableClient();
  let retries = 0;

  while (retries < maxRetries) {
    const retryAfterSeconds = secondsUntilWindowRollover();
    try {
      // Try to read the current row (may not exist on first request of this window).
      let count;
      let eTag;
      try {
        const entity = await client.getEntity(partitionKey, rowKey);
        count = (parseInt(entity.count, 10) || 0) + 1;
        // The @azure/data-tables SDK surfaces the concurrency token as `entity.etag`. Reading it
        // from `entity.odata.metadata.etag` yields undefined, which silently degrades every write
        // into an unconditional overwrite — the exact lost-update race issue #6 reports in the .NET
        // limiter. Under load that means counters undercount and the quota never actually binds.
        eTag = entity.etag;
      } catch (e) {
        if (e?.statusCode === 404 || e?.code === 'ResourceNotFound') {
          // First request in this window: create the row. A concurrent creator may win the race,
          // in which case we retry and take the read path.
          try {
            await client.createEntity({ partitionKey, rowKey, count: 1 });
            return { allowed: 1 <= limit, retryAfterSeconds };
          } catch (createErr) {
            if (createErr?.statusCode === 409 || createErr?.code === 'EntityAlreadyExists') {
              retries++;
              await backoff();
              continue;
            }
            throw createErr;
          }
        }
        throw e; // other read errors are not retryable
      }

      // Conditional update: succeeds only if nobody else wrote since our read (If-Match: eTag).
      // Without a valid eTag we must NOT fall back to an unconditional replace — that would
      // reintroduce the lost update. Treat a missing eTag as a conflict and retry.
      if (!eTag) {
        retries++;
        await backoff();
        continue;
      }
      await client.updateEntity({ partitionKey, rowKey, count }, 'Replace', { etag: eTag });
      return { allowed: count <= limit, retryAfterSeconds };
    } catch (e) {
      if (e?.statusCode === 412 || e?.code === 412 || e?.code === 'UpdateConditionNotSatisfied') {
        // ETag conflict: a concurrent request incremented first. Back off and re-read.
        retries++;
        if (retries >= maxRetries) {
          throw new Error(`rate limit counter contended after ${maxRetries} attempts`);
        }
        await backoff();
        continue;
      }
      throw e; // other errors are not retryable
    }
  }

  throw new Error(`rate limit counter contended after ${maxRetries} attempts`);
}

// Check per-caller quota and per-key quota (independent checks).
// callerOid: the oid from the principal (caller identity).
// keyName: the selected secret name.
// Returns { ok: true } or { ok: false, reason: string, retryAfterSeconds: number }.
//
// Key quota violation must NOT consume caller budget (checked first, caller budget only incremented if key quota passes).
async function quotaCheck(callerOid, keyName, ctx) {
  if (!callerOid || !keyName) {
    // Missing identifiers: fail-closed (reject).
    return { ok: false, reason: 'caller oid or key name missing', retryAfterSeconds: 0 };
  }

  try {
    // Current minute window (yyyyMMddHHmm format, UTC).
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hour = String(now.getUTCHours()).padStart(2, '0');
    const minute = String(now.getUTCMinutes()).padStart(2, '0');
    const window = `${year}${month}${day}${hour}${minute}`;

    // Check per-key quota FIRST (do not increment caller quota if key is over limit).
    const keyResult = await incrementAndCheckWithRetry(
      `key:${window}`,
      keyName,
      QUOTA_KEY_PER_MIN,
    );
    if (!keyResult.allowed) {
      if (ctx) ctx.log(`[rate-limiter] REJECT key=${keyName} quota=${QUOTA_KEY_PER_MIN} (429)`);
      return {
        ok: false,
        reason: `key quota exhausted (${QUOTA_KEY_PER_MIN} per minute)`,
        retryAfterSeconds: keyResult.retryAfterSeconds,
      };
    }

    // Check per-caller quota SECOND (only if key passed).
    const callerResult = await incrementAndCheckWithRetry(
      `caller:${window}`,
      callerOid,
      QUOTA_CALLER_PER_MIN,
    );
    if (!callerResult.allowed) {
      if (ctx) ctx.log(`[rate-limiter] REJECT oid=${callerOid} quota=${QUOTA_CALLER_PER_MIN} (429)`);
      return {
        ok: false,
        reason: `caller quota exhausted (${QUOTA_CALLER_PER_MIN} per minute)`,
        retryAfterSeconds: callerResult.retryAfterSeconds,
      };
    }

    return { ok: true };
  } catch (e) {
    // Table Storage is unreachable or degraded.
    if (ctx) ctx.error(`[rate-limiter] Table Storage error: ${e.message}; fail-${RATE_LIMIT_FAIL_MODE}`);

    if (RATE_LIMIT_FAIL_MODE === 'open') {
      // Fail-open: allow the request (risk: no rate limiting, but service availability > defense-in-depth).
      // Document: this choice prioritizes uptime; operators can use API Management or reverse-proxy
      // throttling as a secondary defense if Table Storage fails.
      return { ok: true };
    } else {
      // Fail-closed (default): reject the request (risk: broker becomes unavailable if Table Storage fails).
      // Document: this choice prioritizes security; operators should monitor Table Storage SLO.
      return {
        ok: false,
        reason: 'rate limit service unavailable',
        retryAfterSeconds: secondsUntilWindowRollover(),
      };
    }
  }
}

module.exports = {
  quotaCheck,
  // Exported for testing + explicit config visibility.
  QUOTA_CALLER_PER_MIN,
  QUOTA_KEY_PER_MIN,
  RATE_LIMIT_TABLE_NAME,
  RATE_LIMIT_FAIL_MODE,
};
