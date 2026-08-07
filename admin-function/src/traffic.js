'use strict';

const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 500;
const MAX_SCAN = 20_000;
const MAX_CONTENT_BYTES = 8 * 1024;

function integer(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new TypeError('traffic query is invalid');
  return parsed;
}

function query(value = {}, now = Date.now()) {
  const hours = integer(value.hours, DEFAULT_HOURS, 1, 168);
  const limit = integer(value.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const since = new Date(now - hours * 60 * 60 * 1000).toISOString();
  return Object.freeze({ hours, limit, since, maxScan: MAX_SCAN });
}

function bounded(value, max = 512) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function idFor(row) {
  return Buffer.from(JSON.stringify([bounded(row.partitionKey, 128), bounded(row.rowKey, 160)]), 'utf8').toString('base64url');
}

function rowKeyFor(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(id)) throw new TypeError('traffic id is invalid');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); } catch { throw new TypeError('traffic id is invalid'); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 'broker-call' || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z-[0-9a-f-]{36}$/i.test(parsed[1])) throw new TypeError('traffic id is invalid');
  return { partitionKey: parsed[0], rowKey: parsed[1] };
}

function summary(row) {
  return Object.freeze({
    id: idFor(row),
    at: bounded(row.at, 64),
    method: bounded(row.method, 12).toUpperCase(),
    route: bounded(row.route, 512),
    status: numeric(row.outcome, 500),
    durationMs: numeric(row.durationMs),
    callerOid: bounded(row.callerOid, 256),
    callerAzp: bounded(row.callerAzp, 256),
    role: bounded(row.role, 512),
    requestContentType: bounded(row.requestContentType, 256),
    requestTruncated: row.requestTruncated === true,
    responseTruncated: row.responseTruncated === true,
    hasRequestContent: Boolean(row.requestContent),
    hasResponseContent: Boolean(row.responseContent),
  });
}

function content(value) {
  const bytes = Buffer.from(typeof value === 'string' ? value : '', 'utf8');
  return bytes.subarray(0, MAX_CONTENT_BYTES).toString('utf8');
}

function detail(row) {
  return Object.freeze({
    ...summary(row),
    request: Object.freeze({
      contentType: bounded(row.requestContentType, 256),
      body: content(row.requestContent),
      truncated: row.requestTruncated === true,
    }),
    response: Object.freeze({
      body: content(row.responseContent),
      truncated: row.responseTruncated === true,
    }),
  });
}

function report(rows, options, { partial = false } = {}) {
  const calls = rows.map(summary).filter((event) => event.at);
  calls.sort((first, second) => second.at.localeCompare(first.at));
  const durations = calls.map((event) => event.durationMs).sort((a, b) => a - b);
  const percentileIndex = durations.length ? Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1) : 0;
  const callers = new Set(calls.map((event) => event.callerOid || event.callerAzp).filter(Boolean));
  const errors = calls.filter((event) => event.status >= 400).length;
  return Object.freeze({
    events: calls.slice(0, options.limit),
    summary: Object.freeze({
      total: calls.length,
      errors,
      errorRate: calls.length ? Math.round(errors * 10_000 / calls.length) / 100 : 0,
      p95DurationMs: durations.length ? durations[percentileIndex] : 0,
      uniqueCallers: callers.size,
      hours: options.hours,
      partial,
    }),
  });
}

module.exports = { detail, query, report, rowKeyFor, summary };
