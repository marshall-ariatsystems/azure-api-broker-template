'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const sdk = require('../../sdk');
const scrubber = require('../src/credential-scrubber');
const fixtures = require('./header-policy-parity-fixtures');

const bridgePolicy = import('../../clients/bridge/request-policy.mjs');
const sensitiveFixtures = [
  ...fixtures.CREDENTIAL_HEADER_FIXTURES,
  ...fixtures.HOP_BY_HOP_HEADER_FIXTURES,
];

function brokerForwards(name) {
  const result = scrubber.filterRequestHeaders(new Map([[name, 'caller-secret']]));
  assert.equal(JSON.stringify(result).includes('caller-secret'), false, `${name} decision leaked a value`);
  return result.ok && Object.keys(result.headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

test('shared header policy is one definition', async () => {
  const bridge = await bridgePolicy;
  assert.strictEqual(bridge.CREDENTIAL_HEADERS, sdk.CREDENTIAL_HEADER_NAMES);
  assert.strictEqual(bridge.HOP_BY_HOP_HEADERS, sdk.HOP_BY_HOP_HEADER_NAMES);
  assert(Object.isFrozen(sdk.CREDENTIAL_HEADER_NAMES));
  assert(Object.isFrozen(sdk.HOP_BY_HOP_HEADER_NAMES));

  for (const name of sensitiveFixtures) {
    assert.equal(sdk.isSensitiveRequestHeader(name), true, name);
    assert.equal(bridge.isBlockedRequestHeader(name), true, name);
    assert.equal(brokerForwards(name), false, name);
  }
});

test('proxy headers rejected both boundaries', async () => {
  const bridge = await bridgePolicy;
  for (const name of [...fixtures.PROXY_HEADER_FIXTURES, ...fixtures.CASE_VARIANTS]) {
    assert.equal(bridge.isBlockedRequestHeader(name), true, name);
    assert.equal(brokerForwards(name), false, name);
  }
  for (const name of fixtures.BENIGN_HEADER_FIXTURES) {
    assert.equal(bridge.isBlockedRequestHeader(name), false, name);
    const result = scrubber.filterRequestHeaders(new Map([[name, 'safe-value']]));
    assert.equal(result.ok, true, name);
    assert.equal(result.headers[name], 'safe-value', name);
  }

  const callerAuthorization = scrubber.filterRequestHeaders(new Map([['authorization', 'caller-secret']]));
  assert.deepEqual(callerAuthorization, { ok: true, headers: {} });
  assert.equal(JSON.stringify(callerAuthorization).includes('caller-secret'), false);
});
