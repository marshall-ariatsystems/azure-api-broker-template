'use strict';

const MAX_DOCUMENT_BYTES = 8 * 1024;
const MAX_STRING_LENGTH = 256;
const PROFILE_KEYS = new Set(['provider', 'routeSlug', 'authMode', 'audienceShape', 'handoffKind']);
const FORBIDDEN_TOPOLOGY = Object.freeze([
  'func-broker-cxapi-csb2cscrdcdka3fy.' + 'centralus-01.azurewebsites.net',
  '10.0.0.' + '10',
  'ce485d55-f7af-40a8-b9d3-' + '12dd64252740',
]);

function fail(message) { throw new TypeError(message); }
function string(value, message) {
  if (typeof value !== 'string' || !value || value.length > MAX_STRING_LENGTH) fail(message);
  return value;
}
function exactKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('profile must be an object');
  const keys = Object.keys(value);
  if (keys.length !== PROFILE_KEYS.size || keys.some((key) => !PROFILE_KEYS.has(key))) fail('profile contains an unknown or missing field');
  if (keys.some((key) => /secret|token|api[-_]?key|password|credential/i.test(key))) fail('profile contains a credential-shaped field');
}
function noTopology(value) {
  if (FORBIDDEN_TOPOLOGY.some((literal) => value.includes(literal))) fail('profile contains forbidden topology');
  return value;
}

function parseNinjaoneProfile(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_DOCUMENT_BYTES) fail('profile must be a bounded JSON string');
  let profile;
  try { profile = JSON.parse(raw); } catch { fail('profile JSON is invalid'); }
  exactKeys(profile);
  if (profile.provider !== 'ninjaone') fail('provider is invalid');
  const routeSlug = noTopology(string(profile.routeSlug, 'routeSlug is invalid'));
  if (!/^[a-z0-9-]{1,64}$/.test(routeSlug)) fail('routeSlug is invalid');
  if (profile.authMode !== 'entra' && profile.authMode !== 'oidc') fail('authMode is invalid');
  const audienceShape = noTopology(string(profile.audienceShape, 'audienceShape is invalid'));
  const handoffKind = noTopology(string(profile.handoffKind, 'handoffKind is invalid'));
  if (profile.authMode === 'entra' && (!audienceShape.startsWith('api://') || !audienceShape.endsWith('/.default'))) fail('audienceShape is invalid for entra');
  if (profile.authMode === 'oidc' && (audienceShape.startsWith('api://') || audienceShape.endsWith('/.default') || !/\baud(?:ience)?\s*:/.test(audienceShape) || !/\bscope\s*:/.test(audienceShape))) fail('audienceShape is invalid for oidc');
  return Object.freeze({ provider: 'ninjaone', routeSlug, authMode: profile.authMode, audienceShape, handoffKind });
}

module.exports = { parseNinjaoneProfile };
