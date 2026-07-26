import assert from 'node:assert/strict';
import test from 'node:test';

import { compatibilityEnvironment, PRESET_NAMES } from '../presets.mjs';

test('standard presets contain only a local endpoint and harmless placeholder', () => {
  assert.deepEqual(PRESET_NAMES, ['openai', 'anthropic', 'generic']);
  assert.deepEqual(compatibilityEnvironment({ preset: 'openai', vendor: 'openai', host: '127.0.0.1', port: 8079 }), {
    OPENAI_BASE_URL: 'http://127.0.0.1:8079/openai/v1', OPENAI_API_KEY: 'broker-managed',
  });
  assert.deepEqual(compatibilityEnvironment({ preset: 'anthropic', vendor: 'anthropic', host: '127.0.0.1', port: 8079 }), {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8079/anthropic', ANTHROPIC_API_KEY: 'broker-managed',
  });
  assert.deepEqual(compatibilityEnvironment({ preset: 'generic', vendor: 'vendor', host: '127.0.0.1', port: 8079 }), {
    VENDOR_BASE_URL: 'http://127.0.0.1:8079/vendor', VENDOR_API_KEY: 'broker-managed',
  });
});

test('explicit mappings may only contain a bridge URL or placeholder', () => {
  assert.deepEqual(compatibilityEnvironment({
    preset: 'openai', vendor: 'openai', host: '127.0.0.1', port: 8079,
    mappings: ['MY_VENDOR_URL=http://127.0.0.1:8079/openai/v1', 'MY_VENDOR_KEY=broker-managed'],
  }), {
    OPENAI_BASE_URL: 'http://127.0.0.1:8079/openai/v1', OPENAI_API_KEY: 'broker-managed',
    MY_VENDOR_URL: 'http://127.0.0.1:8079/openai/v1', MY_VENDOR_KEY: 'broker-managed',
  });
  assert.throws(
    () => compatibilityEnvironment({ preset: 'openai', vendor: 'openai', host: '127.0.0.1', port: 8079, mappings: ['MY_KEY=sk-real'] }),
    /bridge loopback URL or the `broker-managed` placeholder/,
  );
});
