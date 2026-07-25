// credential-scrubber.test.js — unit tests for request/response scrubbing (spec §6.3).
// Run: node function-node/test/credential-scrubber.test.js

const assert = require('assert');
const scrubber = require('../src/credential-scrubber');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- Query Parameter Tests ---

test('checkQueryParameters: clean query passes', () => {
  const result = scrubber.checkQueryParameters('filter=active&sort=name');
  assert.deepStrictEqual(result, { ok: true });
});

test('checkQueryParameters: rejects api_key', () => {
  const result = scrubber.checkQueryParameters('filter=active&api_key=secret123');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'api_key');
});

test('checkQueryParameters: rejects access_token', () => {
  const result = scrubber.checkQueryParameters('access_token=xyz&page=1');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'access_token');
});

test('checkQueryParameters: case-insensitive match', () => {
  const result = scrubber.checkQueryParameters('API_KEY=secret');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'API_KEY');
});

test('checkQueryParameters: rejects percent-encoded names', () => {
  // %61 = 'a', so %61pi_key = 'api_key'
  const result = scrubber.checkQueryParameters('%61pi_key=secret');
  assert.deepStrictEqual(result.ok, false);
  assert.strictEqual(result.field.toLowerCase(), 'api_key');
});

test('checkQueryParameters: allows a generic pagination token', () => {
  const result = scrubber.checkQueryParameters('token=bearer123');
  assert.deepStrictEqual(result, { ok: true });
});

test('checkQueryParameters: rejects authorization', () => {
  const result = scrubber.checkQueryParameters('authorization=Bearer%20xyz');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'authorization');
});

test('checkQueryParameters: empty query passes', () => {
  const result = scrubber.checkQueryParameters('');
  assert.deepStrictEqual(result, { ok: true });
});

// Regression guard: an earlier version called decodeURIComponent() on the whole query string before
// parsing. decodeURIComponent throws URIError on any malformed escape, so `?a=%` turned every such
// request into an unhandled 500 — a one-character denial of service. URLSearchParams is lenient and
// decodes parameter NAMES on its own, so no pre-decode is needed or wanted.
test('checkQueryParameters: malformed percent-encoding does not throw', () => {
  assert.doesNotThrow(() => scrubber.checkQueryParameters('a=%'));
  assert.deepStrictEqual(scrubber.checkQueryParameters('a=%').ok, true);
  // …and detection still works alongside the malformed value.
  assert.deepStrictEqual(scrubber.checkQueryParameters('a=%&api_key=x').ok, false);
});

test('checkQueryParameters: percent-encoded parameter NAME is still detected', () => {
  const result = scrubber.checkQueryParameters('%61pi_key=secret');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'api_key');
});

// --- Body Tests (JSON) ---

test('checkRequestBody JSON: clean object passes', () => {
  const body = Buffer.from(JSON.stringify({ name: 'test', id: 123 }));
  const result = scrubber.checkRequestBody(body, 'application/json');
  assert.deepStrictEqual(result, { ok: true });
});

test('checkRequestBody JSON: rejects api_key field', () => {
  const body = Buffer.from(JSON.stringify({ api_key: 'secret', name: 'test' }));
  const result = scrubber.checkRequestBody(body, 'application/json');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'api_key');
});

test('checkRequestBody JSON: rejects nested access_token', () => {
  const body = Buffer.from(JSON.stringify({
    name: 'test',
    auth: { access_token: 'xyz' },
  }));
  const result = scrubber.checkRequestBody(body, 'application/json');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'access_token');
});

test('checkRequestBody JSON: rejects deeply nested client_secret', () => {
  const body = Buffer.from(JSON.stringify({
    level1: { level2: { level3: { client_secret: 'xyz' } } },
  }));
  const result = scrubber.checkRequestBody(body, 'application/json');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'client_secret');
});

test('checkRequestBody JSON: rejects credential in array', () => {
  const body = Buffer.from(JSON.stringify({
    items: [
      { id: 1, name: 'a' },
      { id: 2, authorization: 'Bearer xyz' },
    ],
  }));
  const result = scrubber.checkRequestBody(body, 'application/json');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'authorization');
});

test('checkRequestBody JSON: unparseable JSON fails-closed', () => {
  const body = Buffer.from('{invalid json}');
  const result = scrubber.checkRequestBody(body, 'application/json');
  assert.deepStrictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'unparseable JSON');
});

test('checkRequestBody JSON: case-insensitive field match', () => {
  const body = Buffer.from(JSON.stringify({ Access_Token: 'xyz' }));
  const result = scrubber.checkRequestBody(body, 'application/json');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'Access_Token');
});

test('checkRequestBody JSON: allows generic key and token fields at any depth', () => {
  const body = Buffer.from(JSON.stringify({ key: 'lookup-key', page: { token: 'next-page' } }));
  assert.deepStrictEqual(scrubber.checkRequestBody(body, 'application/json'), { ok: true });
});

// --- Body Tests (Form) ---

test('checkRequestBody form: clean form passes', () => {
  const body = Buffer.from('name=test&id=123');
  const result = scrubber.checkRequestBody(body, 'application/x-www-form-urlencoded');
  assert.deepStrictEqual(result, { ok: true });
});

test('checkRequestBody form: rejects api_key field', () => {
  const body = Buffer.from('name=test&api_key=secret');
  const result = scrubber.checkRequestBody(body, 'application/x-www-form-urlencoded');
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'api_key');
});

test('checkRequestBody form: form with only encoding errors passes (URLSearchParams lenient)', () => {
  // URLSearchParams does NOT throw on incomplete percent-encoding; it parses leniently.
  // This is acceptable because the vendor will reject malformed requests.
  // Only reject forms that would be parseable but contain credentials.
  const body = Buffer.from('name=%ZZ');
  const result = scrubber.checkRequestBody(body, 'application/x-www-form-urlencoded');
  assert.deepStrictEqual(result.ok, true);
});

// --- Body Tests (Other Content Types) ---

test('checkRequestBody octet-stream: passes through unchanged', () => {
  const body = Buffer.from('binary data');
  const result = scrubber.checkRequestBody(body, 'application/octet-stream');
  assert.deepStrictEqual(result, { ok: true });
});

test('checkRequestBody multipart: passes through unchanged', () => {
  const body = Buffer.from('------WebKitFormBoundary\r\nContent-Disposition: form-data\r\n');
  const result = scrubber.checkRequestBody(body, 'multipart/form-data; boundary=----WebKitFormBoundary');
  assert.deepStrictEqual(result, { ok: true });
});

test('checkRequestBody no type: passes through', () => {
  const body = Buffer.from('any data');
  const result = scrubber.checkRequestBody(body, null);
  assert.deepStrictEqual(result, { ok: true });
});

test('checkRequestBody empty body: passes', () => {
  const result = scrubber.checkRequestBody(null, 'application/json');
  assert.deepStrictEqual(result, { ok: true });
});

// --- Header Tests ---

test('filterRequestHeaders: allowlists clean headers', () => {
  const headers = new Map([
    ['Accept', 'application/json'],
    ['User-Agent', 'TestAgent/1.0'],
    ['Content-Type', 'application/json'],
  ]);
  const result = scrubber.filterRequestHeaders(headers);
  assert.deepStrictEqual(result.ok, true);
  assert(result.headers['Accept']);
  assert(result.headers['User-Agent']);
  assert(result.headers['Content-Type']);
});

test('filterRequestHeaders: drops non-allowlisted headers', () => {
  const headers = new Map([
    ['Accept', 'application/json'],
    ['X-Custom-Header', 'value'],
  ]);
  const result = scrubber.filterRequestHeaders(headers);
  assert.deepStrictEqual(result.ok, true);
  assert(result.headers['Accept']);
  assert(!result.headers['X-Custom-Header']);
});

test('filterRequestHeaders: rejects x-api-key', () => {
  const headers = new Map([
    ['Accept', 'application/json'],
    ['x-api-key', 'secret123'],
  ]);
  const result = scrubber.filterRequestHeaders(headers);
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'x-api-key');
});

// Regression guard: Easy Auth forwards the caller's own `Authorization: Bearer <entra-token>` to the
// app, so EVERY legitimate request carries it (see clients/call-broker.sh, clients/broker_client.py,
// clients/node/ninja-client.mjs, test/broker-smoketest.sh). It must be STRIPPED, never rejected —
// rejecting it 400s all real traffic.
test('filterRequestHeaders: STRIPS the caller Entra token, does not reject it', () => {
  const headers = new Map([
    ['Accept', 'application/json'],
    ['Authorization', 'Bearer entra-token'],
  ]);
  const result = scrubber.filterRequestHeaders(headers);
  assert.deepStrictEqual(result.ok, true);
  assert(result.headers['Accept']);
  assert(!('Authorization' in result.headers));
});

test('filterRequestHeaders: strips Easy Auth x-ms-* headers without rejecting', () => {
  const headers = new Map([
    ['Accept', 'application/json'],
    ['x-ms-client-principal', 'base64blob'],
    ['X-MS-TOKEN-AAD-ACCESS-TOKEN', 'tok'],
  ]);
  const result = scrubber.filterRequestHeaders(headers);
  assert.deepStrictEqual(result.ok, true);
  assert(!('x-ms-client-principal' in result.headers));
  assert(!('X-MS-TOKEN-AAD-ACCESS-TOKEN' in result.headers));
});

test('filterRequestHeaders: rejects deployment-configured injection headers', () => {
  const headers = new Map([
    ['Accept', 'application/json'],
    ['x-api-key-id', 'key123'],
  ]);
  const result = scrubber.filterRequestHeaders(headers);
  assert.deepStrictEqual(result.ok, false);
  assert.deepStrictEqual(result.field, 'x-api-key-id');
});

test('filterRequestHeaders: case-insensitive allowlist match', () => {
  const headers = new Map([
    ['accept', 'application/json'],
    ['ACCEPT-ENCODING', 'gzip'],
    ['Content-Type', 'application/json'],
  ]);
  const result = scrubber.filterRequestHeaders(headers);
  assert.deepStrictEqual(result.ok, true);
  assert(result.headers['accept']);
  assert(result.headers['ACCEPT-ENCODING']);
});

test('filterRequestHeaders: preserves standard compatibility headers', () => {
  const headers = new Map([
    ['If-Match', '"v1"'],
    ['Idempotency-Key', 'request-1'],
    ['X-Correlation-Id', 'correlation-1'],
    ['Range', 'bytes=0-10'],
  ]);
  const result = scrubber.filterRequestHeaders(headers);
  assert.deepStrictEqual(result.ok, true);
  assert.deepStrictEqual(result.headers, Object.fromEntries(headers));
});

// --- Response Scrubbing Tests ---

test('scrubResponseHeaders: removes credential-shaped headers', () => {
  const headers = new Map([
    ['Content-Type', 'application/json'],
    ['X-Api-Key', 'secret'],
    ['Authorization', 'Bearer xyz'],
  ]);
  const result = scrubber.scrubResponseHeaders(headers);
  assert(result['Content-Type']);
  assert(!result['X-Api-Key']);
  assert(!result['Authorization']);
});

test('scrubResponseBody JSON: redacts credential fields', () => {
  const body = Buffer.from(JSON.stringify({
    data: { name: 'test' },
    api_key: 'secret123',
  }));
  const result = scrubber.scrubResponseBody(body, 'application/json');
  const scrubbed = JSON.parse(result.buffer.toString());
  assert.deepStrictEqual(scrubbed.data.name, 'test');
  assert.deepStrictEqual(scrubbed.api_key, '[redacted]');
  assert.deepStrictEqual(result.modified, true);
});

test('scrubResponseBody JSON: redacts nested credentials', () => {
  const body = Buffer.from(JSON.stringify({
    status: 'ok',
    error: { code: 401, access_token: 'xyz' },
  }));
  const result = scrubber.scrubResponseBody(body, 'application/json');
  const scrubbed = JSON.parse(result.buffer.toString());
  assert.deepStrictEqual(scrubbed.error.access_token, '[redacted]');
  assert.deepStrictEqual(result.modified, true);
});

test('scrubResponseBody JSON: redacts credentials in arrays', () => {
  const body = Buffer.from(JSON.stringify({
    items: [
      { id: 1, name: 'a' },
      { id: 2, authorization: 'Bearer xyz' },
    ],
  }));
  const result = scrubber.scrubResponseBody(body, 'application/json');
  const scrubbed = JSON.parse(result.buffer.toString());
  assert.deepStrictEqual(scrubbed.items[1].authorization, '[redacted]');
  assert.deepStrictEqual(result.modified, true);
});

test('scrubResponseBody JSON: non-JSON content-type passes through', () => {
  const body = Buffer.from('api_key=secret');
  const result = scrubber.scrubResponseBody(body, 'text/plain');
  assert.deepStrictEqual(result.buffer, body);
  assert.deepStrictEqual(result.modified, false);
});

test('scrubResponseBody JSON: invalid JSON passes through', () => {
  const body = Buffer.from('{invalid}');
  const result = scrubber.scrubResponseBody(body, 'application/json');
  assert.deepStrictEqual(result.buffer, body);
  assert.deepStrictEqual(result.modified, false);
});

test('scrubResponseBody JSON: no credentials = no modification', () => {
  const body = Buffer.from(JSON.stringify({ name: 'test', id: 123 }));
  const result = scrubber.scrubResponseBody(body, 'application/json');
  assert.deepStrictEqual(result.modified, false);
});

// --- Run All Tests ---

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`PASS  ${name}`);
      passed++;
    } catch (e) {
      console.log(`FAIL  ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
