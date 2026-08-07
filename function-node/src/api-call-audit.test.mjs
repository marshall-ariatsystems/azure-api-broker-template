import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { captureRequestContent } = require('./api-call-audit');

test('traffic audit retains bounded non-credential request content', async () => {
  const request = new Request('https://broker.example/api/broker/vendor/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ item: 'safe' }),
  });

  const captured = await captureRequestContent(request);
  assert.equal(captured.value, '{"item":"safe"}');
  assert.equal(captured.contentType, 'application/json');
  assert.equal(captured.truncated, false);
});

test('traffic audit omits credential-shaped request content', async () => {
  const request = new Request('https://broker.example/api/broker/vendor/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nested: { api_key: 'must-not-be-retained' } }),
  });

  const captured = await captureRequestContent(request);
  assert.equal(captured.value, '[omitted: credential-shaped request content]');
  assert.doesNotMatch(captured.value, /must-not-be-retained/);
});

test('traffic audit never reads bodies from GET requests', async () => {
  const request = new Request('https://broker.example/api/broker/vendor/items', {
    headers: { 'content-type': 'application/json' },
  });

  assert.deepEqual(await captureRequestContent(request), { value: '', truncated: false, contentType: 'application/json' });
});
