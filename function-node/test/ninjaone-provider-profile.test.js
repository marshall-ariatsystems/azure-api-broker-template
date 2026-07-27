'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseNinjaoneProfile } = require('../src/ninjaone-provider-profile');
const { ENTRA_PROFILE, OIDC_PROFILE, FORBIDDEN_TOPOLOGY } = require('./ninjaone-provider-fixtures');

test('entra profile parsed', () => {
  const profile = parseNinjaoneProfile(ENTRA_PROFILE);
  assert(Object.isFrozen(profile));
  assert.equal(profile.authMode, 'entra');
  assert.equal(profile.audienceShape, 'api://<broker-app-id>/.default');
});

test('oidc profile parsed', () => {
  const profile = parseNinjaoneProfile(OIDC_PROFILE);
  assert(Object.isFrozen(profile));
  assert.equal(profile.authMode, 'oidc');
  assert.match(profile.audienceShape, /aud:/);
});

test('profile rejects unknown, missing, mixed-mode, topology, and credential-shaped fields', () => {
  const entra = JSON.parse(ENTRA_PROFILE);
  const oidc = JSON.parse(OIDC_PROFILE);
  assert.throws(() => parseNinjaoneProfile(JSON.stringify({ ...entra, extra: 'x' })), TypeError);
  const { handoffKind, ...missing } = entra;
  assert.throws(() => parseNinjaoneProfile(JSON.stringify(missing)), TypeError);
  assert.throws(() => parseNinjaoneProfile(JSON.stringify({ ...oidc, audienceShape: entra.audienceShape })), TypeError);
  assert.throws(() => parseNinjaoneProfile(JSON.stringify({ ...entra, audienceShape: oidc.audienceShape })), TypeError);
  for (const literal of FORBIDDEN_TOPOLOGY) assert.throws(() => parseNinjaoneProfile(JSON.stringify({ ...entra, handoffKind: literal })), TypeError);
  for (const key of ['secret', 'token', 'apiKey']) assert.throws(() => parseNinjaoneProfile(JSON.stringify({ ...entra, [key]: 'x' })), TypeError);
  for (const profile of [parseNinjaoneProfile(ENTRA_PROFILE), parseNinjaoneProfile(OIDC_PROFILE)]) {
    const text = JSON.stringify(profile);
    for (const literal of FORBIDDEN_TOPOLOGY) assert.equal(text.includes(literal), false);
  }
});
