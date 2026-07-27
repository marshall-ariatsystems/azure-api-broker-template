'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { parseSecretCacheTtlSeconds } = require('../src/role-routing');
const fixtures = require('./role-routing-fixtures');

test('secret cache ttl policy', () => {
  assert.equal(parseSecretCacheTtlSeconds(undefined), fixtures.TTL_DEFAULT_SECONDS);
  assert.equal(parseSecretCacheTtlSeconds(null), fixtures.TTL_DEFAULT_SECONDS);
  for (const raw of fixtures.TTL_VALID) assert.equal(parseSecretCacheTtlSeconds(raw), Number(raw));
  for (const raw of fixtures.TTL_INVALID) {
    assert.throws(() => parseSecretCacheTtlSeconds(raw), (error) => {
      assert.equal(error.message, 'invalid SECRET_CACHE_TTL_SECONDS');
      if (raw.trim()) assert.equal(error.message.includes(raw), false);
      return true;
    });
  }
});

test('secret cache ttl fails closed', () => {
  const brokerPath = path.join(__dirname, '..', 'src', 'broker.js');
  const originalLoad = Module._load;
  const originalTtl = process.env.SECRET_CACHE_TTL_SECONDS;
  let secretFetches = 0;
  process.env.SECRET_CACHE_TTL_SECONDS = 'invalid-value';
  delete require.cache[require.resolve(brokerPath)];
  Module._load = function(request, ...args) {
    if (request === '@azure/functions') return { app: { http() {} } };
    if (request === '@azure/identity') return { DefaultAzureCredential: class {} };
    if (request === '@azure/keyvault-secrets') return { SecretClient: class { async getSecret() { secretFetches++; } } };
    return originalLoad.call(this, request, ...args);
  };
  try {
    assert.throws(() => require(brokerPath), (error) => {
      assert.equal(error.message, 'invalid SECRET_CACHE_TTL_SECONDS');
      for (const forbidden of fixtures.FORBIDDEN_TOPOLOGY) assert.equal(error.message.includes(forbidden), false);
      assert.equal(error.message.includes('invalid-value'), false);
      return true;
    });
    assert.equal(secretFetches, 0);
  } finally {
    Module._load = originalLoad;
    if (originalTtl === undefined) delete process.env.SECRET_CACHE_TTL_SECONDS;
    else process.env.SECRET_CACHE_TTL_SECONDS = originalTtl;
    delete require.cache[require.resolve(brokerPath)];
  }
});
