import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { detail, query, report, rowKeyFor, summary } = require('./traffic');

const row = {
  partitionKey: 'broker-call',
  rowKey: '2026-08-07T12:34:56.000Z-00000000-0000-4000-8000-000000000000',
  at: '2026-08-07T12:34:56.000Z',
  action: 'broker.api.call',
  method: 'get',
  route: 'ninjaone/v2/devices',
  outcome: '200',
  durationMs: '42',
  callerOid: 'user-object-id',
  callerAzp: 'application-id',
  role: 'VendorApi.Ninjaone.Invoke',
  requestContentType: 'application/json',
  requestContent: '{"device":"safe"}',
  responseContent: '{"ok":true}',
  requestTruncated: false,
  responseTruncated: false,
};

test('traffic summaries expose bounded metadata without bodies', () => {
  const value = summary(row);
  assert.equal(value.status, 200);
  assert.equal(value.durationMs, 42);
  assert.equal(value.hasResponseContent, true);
  assert.equal('requestContent' in value, false);
  assert.equal('responseContent' in value, false);
  assert.deepEqual(rowKeyFor(value.id), { partitionKey: row.partitionKey, rowKey: row.rowKey });
});

test('traffic details expose only the already-scrubbed bounded content', () => {
  const value = detail({ ...row, responseContent: 'x'.repeat(9000) });
  assert.equal(value.request.body, row.requestContent);
  assert.equal(Buffer.byteLength(value.response.body), 8192);
  assert.equal('authorization' in value, false);
  assert.equal('headers' in value, false);
});

test('traffic query bounds time windows and result counts', () => {
  assert.deepEqual(query({}, Date.parse('2026-08-07T12:00:00Z')), { hours: 24, limit: 250, since: '2026-08-06T12:00:00.000Z', maxScan: 20000 });
  assert.throws(() => query({ hours: '169' }), /invalid/);
  assert.throws(() => query({ limit: '501' }), /invalid/);
  assert.throws(() => rowKeyFor('not-an-id'), /invalid/);
});

test('traffic reports calculate errors, p95 latency, callers, and newest-first rows', () => {
  const rows = [
    { ...row, rowKey: row.rowKey.replace('12:34:56', '12:34:55'), at: '2026-08-07T12:34:55.000Z', outcome: '500', durationMs: '1000' },
    row,
  ];
  const value = report(rows, query({ hours: 1, limit: 1 }), { partial: true });
  assert.equal(value.events.length, 1);
  assert.equal(value.events[0].status, 200);
  assert.deepEqual(value.summary, { total: 2, errors: 1, errorRate: 50, p95DurationMs: 1000, uniqueCallers: 1, hours: 1, partial: true });
});
