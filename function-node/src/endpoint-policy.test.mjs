import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeEndpointPolicy, evaluateEndpointPolicy, normalizePath } = require('./endpoint-policy.js');

test('no policy means the connection is unrestricted', () => {
  assert.equal(normalizeEndpointPolicy(undefined), null);
  assert.equal(normalizeEndpointPolicy(null), null);
  const decision = evaluateEndpointPolicy(null, { method: 'POST', subpath: 'anything/goes' });
  assert.equal(decision.allowed, true);
});

test('allow mode is default-deny: only listed endpoints pass', () => {
  const policy = normalizeEndpointPolicy({
    mode: 'allow',
    rules: [
      { methods: ['POST'], path: '/v1/chat/completions' },
      { methods: ['POST'], path: '/v1/embeddings' },
    ],
  });
  assert.equal(evaluateEndpointPolicy(policy, { method: 'POST', subpath: 'v1/chat/completions' }).allowed, true);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'POST', subpath: 'v1/embeddings' }).allowed, true);
  // Not listed -> denied.
  assert.equal(evaluateEndpointPolicy(policy, { method: 'POST', subpath: 'v1/files' }).allowed, false);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'DELETE', subpath: 'v1/files/abc' }).allowed, false);
});

test('method is enforced within an allow rule', () => {
  const policy = normalizeEndpointPolicy({ mode: 'allow', rules: [{ methods: ['POST'], path: '/v1/chat/completions' }] });
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: 'v1/chat/completions' }).allowed, false);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'post', subpath: 'v1/chat/completions' }).allowed, true); // case-insensitive
});

test('a rule without methods matches any method', () => {
  const policy = normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '/v1/models' }] });
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: 'v1/models' }).allowed, true);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'HEAD', subpath: 'v1/models' }).allowed, true);
});

test('prefix rules match a subtree', () => {
  const policy = normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '/v1/models', prefix: true }] });
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: 'v1/models' }).allowed, true);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: 'v1/models/gpt-4o' }).allowed, true);
  // Exact-only rule does not match a child path.
  const exact = normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '/v1/models' }] });
  assert.equal(evaluateEndpointPolicy(exact, { method: 'GET', subpath: 'v1/models/gpt-4o' }).allowed, false);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: 'v1/models-evil' }).allowed, false);
});

test('encoded separators and dot segments cannot bypass path rules', () => {
  const policy = normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '/v1/models', prefix: true }] });
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: '/v1/models/%2e%2e/secrets' }).allowed, false);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: '/v1/models%2f..%2fsecrets' }).allowed, false);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: '/v1/models%5cadmin' }).allowed, false);
});

test('deny mode is default-allow: only listed endpoints are blocked', () => {
  const policy = normalizeEndpointPolicy({
    mode: 'deny',
    rules: [{ path: '/v1/fine_tuning', prefix: true }, { methods: ['DELETE'], path: '/v1/files', prefix: true }],
  });
  assert.equal(evaluateEndpointPolicy(policy, { method: 'POST', subpath: 'v1/chat/completions' }).allowed, true);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'POST', subpath: 'v1/fine_tuning/jobs' }).allowed, false);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'DELETE', subpath: 'v1/files/abc' }).allowed, false);
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: 'v1/files/abc' }).allowed, true); // GET not denied
});

test('slash-collapsing prevents exact-match evasion', () => {
  assert.equal(normalizePath('v1//chat///completions'), '/v1/chat/completions');
  const policy = normalizeEndpointPolicy({ mode: 'allow', rules: [{ methods: ['POST'], path: '/v1/chat/completions' }] });
  assert.equal(evaluateEndpointPolicy(policy, { method: 'POST', subpath: 'v1//chat//completions' }).allowed, true);
});

test('query strings never leak into path matching', () => {
  const policy = normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '/v1/models' }] });
  assert.equal(evaluateEndpointPolicy(policy, { method: 'GET', subpath: 'v1/models?leak=1' }).allowed, true);
});

test('malformed policy shapes are rejected at normalize time', () => {
  assert.throws(() => normalizeEndpointPolicy({ mode: 'nope', rules: [{ path: '/x' }] }), /mode/);
  assert.throws(() => normalizeEndpointPolicy({ mode: 'allow', rules: [] }), /1\.\.256/);
  assert.throws(() => normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '' }] }), /path/);
  assert.throws(() => normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '/x', prefix: 'yes' }] }), /prefix/);
  assert.throws(() => normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '/x', bogus: 1 }] }), /rule is invalid/);
  assert.throws(() => normalizeEndpointPolicy({ mode: 'allow', rules: [{ path: '/x', methods: [] }] }), /methods/);
});

test('a policy value that slipped past validation is fail-closed at evaluate time', () => {
  // Not a normalized policy object -> deny, never silently allow.
  assert.equal(evaluateEndpointPolicy({ malformed: true }, { method: 'GET', subpath: 'v1/models' }).allowed, false);
  assert.equal(evaluateEndpointPolicy({ mode: 'allow' }, { method: 'GET', subpath: 'v1/models' }).allowed, false);
});
