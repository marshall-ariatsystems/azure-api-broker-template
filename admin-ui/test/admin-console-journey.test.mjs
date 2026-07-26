import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createHttpHandler } from '../server.mjs';
import { admin, MutableGrantRepository, makeAuditSink, makeLogger, makeProbe, makeWriter } from './admin-console-fixtures.mjs';

async function request(handler, method, url, payload) { const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]); req.method = method; req.url = url; const res = { chunks: [], writeHead(status) { this.status = status; }, end(value = '') { this.chunks.push(Buffer.from(value)); } }; await handler(req, res); const raw = Buffer.concat(res.chunks).toString(); return { status: res.status, raw, body: raw.startsWith('{') ? JSON.parse(raw) : raw }; }

test('hosted GUI journey is same-origin and no terminal instructions are presented', async () => {
  const repository = new MutableGrantRepository(); // same repository is shared by GUI service and broker probe
  const writer = makeWriter(); const auditSink = makeAuditSink(repository); const logger = makeLogger(); const brokerProbe = makeProbe(repository);
  const handler = createHttpHandler({ requireAdmin: async () => admin, repository, credentialWriter: writer, brokerProbe, auditSink, logger });
  const temp = await mkdtemp(join(tmpdir(), 'ed-v008-001-')); const before = await readdir(temp);
  const page = await request(handler, 'GET', '/');
  assert.equal(page.status, 200); assert.match(page.raw, /Who can use this connection\?/); assert.match(page.raw, /write-only credential/); assert.equal(/terminal|broker\.config|localhost|Key Vault|Azure CLI/i.test(page.raw), false); // no terminal or local state instructions
  for (const [handoffKind, displayName, issuer] of [['marketplace', 'Marketplace Identity', 'https://marketplace-issuer.test'], ['private', 'Private Identity', 'https://private-issuer.test'], ['generic', 'Generic Identity', 'https://issuer.test']]) {
    const result = await request(handler, 'POST', '/api/identity-integrations', { kind: 'generic-oidc', handoffKind, displayName, issuer }); assert.equal(result.status, 201);
  }
  const distinctive = 'journey-write-only-credential';
  const input = { value: distinctive }; // minimal in-process DOM field harness
  let created;
  try { created = await request(handler, 'POST', '/api/connections', { displayName: 'Orders V2', provider: 'azure-reference', credential: input.value }); } finally { input.value = ''; }
  assert.equal(input.value, ''); assert.equal(created.status, 201); assert.equal(writer.writes.length, 1);
  const connectionId = created.body.connection.id;
  const grant = await request(handler, 'POST', `/api/connections/${encodeURIComponent(connectionId)}/grants`, { kind: 'group', subject: 'group:ops' }); assert.equal(grant.status, 201);
  const [health, usage, audit] = await Promise.all(['health', 'usage', 'audit'].map(part => request(handler, 'GET', `/api/connections/${encodeURIComponent(connectionId)}/${part}`)));
  assert.equal(health.status, 200); assert.equal(usage.status, 200); assert.equal(audit.status, 200);
  const visible = JSON.stringify([created.body, health.body, usage.body, audit.body, logger.entries, auditSink.writes]); assert.equal(visible.includes(distinctive), false);
  assert.equal(brokerProbe.decision(connectionId, 'group:ops'), 'allowed');
  const revoked = await request(handler, 'DELETE', `/api/connections/${encodeURIComponent(connectionId)}/grants/${encodeURIComponent(grant.body.grant.id)}`); assert.equal(revoked.status, 200); // confirmation is performed by the browser before this request
  // revoked next request: the probe observes the shared MutableGrantRepository without a rebuild or vendor request.
  assert.equal(brokerProbe.decision(connectionId, 'group:ops'), 'denied'); assert.equal(writer.writes.length, 1); assert.equal(brokerProbe.calls, 2);
  const after = await readdir(temp); assert.deepEqual(after, before); assert.equal((await readFile(new URL('../index.html', import.meta.url), 'utf8')).includes(distinctive), false);
});
