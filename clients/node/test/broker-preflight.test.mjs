import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrokerConfig, runPreflight } from '../broker-preflight.mjs';

const valid = {
  BROKER_BASE: ' https://broker.example.test/api/broker/ ',
  BROKER_SCOPE: ' api://00000000-0000-0000-0000-000000000000/.default ',
};

test('node config required', () => {
  assert.deepEqual(loadBrokerConfig(valid), {
    base: 'https://broker.example.test/api/broker',
    scope: 'api://00000000-0000-0000-0000-000000000000/.default',
  });
  for (const [env, variable] of [
    [{ BROKER_SCOPE: valid.BROKER_SCOPE }, 'BROKER_BASE'],
    [{ BROKER_BASE: valid.BROKER_BASE }, 'BROKER_SCOPE'],
    [{ ...valid, BROKER_BASE: '   ' }, 'BROKER_BASE'],
    [{ ...valid, BROKER_SCOPE: '  ' }, 'BROKER_SCOPE'],
    [{ ...valid, BROKER_BASE: 'http://broker.example.test' }, 'BROKER_BASE'],
    [{ ...valid, BROKER_SCOPE: 'api:///bad' }, 'BROKER_SCOPE'],
  ]) {
    assert.throws(() => loadBrokerConfig(env), (error) => {
      assert.match(error.message, new RegExp(variable));
      assert.doesNotMatch(error.message, /DISTINCTIVE-BEARER/);
      return true;
    });
  }
});

test('node preflight surfaces only status and correlation', async () => {
  const config = loadBrokerConfig(valid);
  const acquireToken = async () => 'DISTINCTIVE-BEARER';
  const result = await runPreflight({
    config,
    acquireToken,
    invokePreflight: async () => ({
      status: 200,
      correlationId: 'req-01HZ_client.abc-0001',
      authorization: 'allowed',
    }),
  });
  assert.deepEqual(result, { status: 200, correlationId: 'req-01HZ_client.abc-0001' });
  assert.doesNotMatch(JSON.stringify(result), /DISTINCTIVE-BEARER/);

  const denied = await runPreflight({
    config,
    acquireToken,
    invokePreflight: async () => ({ status: 403, correlationId: 'req-01HZ_client.abc-0002', authorization: 'role-denied' }),
  });
  assert.deepEqual(denied, { status: 403, correlationId: 'req-01HZ_client.abc-0002' });
});
