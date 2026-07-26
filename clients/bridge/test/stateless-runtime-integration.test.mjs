import assert from 'node:assert/strict';
import test from 'node:test';
import { INHERITED_ENVIRONMENT_KEYS, inheritedEnvironment } from '../launcher.mjs';
import { parseCli } from '../cli.mjs';
import { LOGIN_REQUIRED } from '../broker-bridge.mjs';

test('restart session begins unauthenticated with the exact denial', () => assert.equal(LOGIN_REQUIRED, 'login required; run broker-bridge login'));
test('restart session CLI requires invocation-only HTTPS discovery', () => { assert.match(parseCli(['serve']).error, /--broker/); assert.match(parseCli(['serve', '--broker', 'http://bad.test']).error, /HTTPS/); });
test('restart session never accepts config or host flags', () => { assert.match(parseCli(['serve', '--broker', 'https://broker.test', '--config', 'x']).error, /accepts only/); assert.match(parseCli(['serve', '--broker', 'https://broker.test', '--host', 'localhost']).error, /accepts only/); });
test('restart session child environment is the exact platform allowlist', () => { const environment = { PATH: '/bin', LANG: 'C', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', CLIENT_SECRET: 'secret', ACCESS_TOKEN: 'secret', AUTHORIZATION: 'secret', UNRELATED_INHERITED_VALUE: 'secret' }; const actual = inheritedEnvironment(environment); assert.deepEqual(Object.keys(actual).sort(), ['LANG', 'PATH']); for (const key of INHERITED_ENVIRONMENT_KEYS) if (environment[key] !== undefined) assert.equal(actual[key], environment[key]); assert.equal(JSON.stringify(actual).includes('secret'), false); });
test('restart session application compatibility can add only generated values', () => { const environment = inheritedEnvironment({ PATH: '/bin' }); const applicationEnvironment = { ...environment, OPENAI_BASE_URL: 'http://127.0.0.1:8079/openai/v1', OPENAI_API_KEY: 'broker-managed' }; assert.deepEqual(applicationEnvironment, { PATH: '/bin', OPENAI_BASE_URL: 'http://127.0.0.1:8079/openai/v1', OPENAI_API_KEY: 'broker-managed' }); });
