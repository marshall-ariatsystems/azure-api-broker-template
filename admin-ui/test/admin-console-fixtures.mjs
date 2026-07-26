export const identityIntegration = Object.freeze({
  id: 'idp:acme', kind: 'generic-oidc', handoffKind: 'generic', displayName: 'Acme Identity',
  issuer: 'https://issuer.test', status: 'connected',
});
export const identityIntegrationHandoffs = Object.freeze([
  Object.freeze({ id: 'idp:marketplace', kind: 'generic-oidc', handoffKind: 'marketplace', displayName: 'Marketplace Identity', issuer: 'https://marketplace-issuer.test', status: 'connected' }),
  Object.freeze({ id: 'idp:private', kind: 'generic-oidc', handoffKind: 'private', displayName: 'Private Registration Identity', issuer: 'https://private-issuer.test', status: 'connected' }), identityIntegration,
]);
export const publicConnection = Object.freeze({ id: 'azure:orders', provider: 'azure-reference', displayName: 'Orders', status: 'healthy', createdAt: '2026-07-26T00:00:00.000Z' });
export const grants = Object.freeze([{ id: 'grant:ops', connectionId: 'azure:orders', subject: 'group:ops', kind: 'group' }]);
export const usage = Object.freeze({ connectionId: 'azure:orders', window: '24h', requests: 7, denied: 1, status: 'healthy', observedAt: '2026-07-26T00:00:00.000Z' });
export const audit = Object.freeze([{ at: '2026-07-26T00:00:00.000Z', action: 'grant.created', connectionId: 'azure:orders', outcome: 'allowed' }]);
export const admin = Object.freeze({ subject: 'admin:operator', permissions: Object.freeze(['admin:connections']) });

export class MutableGrantRepository {
  constructor() { this.identities = [...identityIntegrationHandoffs]; this.connections = [publicConnection]; this.grants = [...grants]; this.audit = [...audit]; this.calls = 0; }
  touch() { this.calls += 1; }
  listIdentityIntegrations() { this.touch(); return this.identities; }
  getIdentityIntegration(id) { this.touch(); return this.identities.find(x => x.id === id); }
  createIdentityIntegration(value) { this.touch(); const saved = { id: `idp:${value.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, ...value }; this.identities.push(saved); return saved; }
  listConnections() { this.touch(); return this.connections; }
  getConnection(id) { this.touch(); return this.connections.find(x => x.id === id); }
  createConnection(value) { this.touch(); this.connections.push(value); return value; }
  listGrants(connectionId) { this.touch(); return this.grants.filter(x => x.connectionId === connectionId); }
  createGrant(value) { this.touch(); this.grants.push(value); return value; }
  deleteGrant(connectionId, id) { this.touch(); const index = this.grants.findIndex(x => x.connectionId === connectionId && x.id === id); return index < 0 ? null : this.grants.splice(index, 1)[0]; }
  getUsage(connectionId) { this.touch(); return { ...usage, connectionId }; }
  listAudit(connectionId) { this.touch(); return this.audit.filter(x => x.connectionId === connectionId); }
}
export function makeWriter() { const writes = []; return { writes, async write(value) { writes.push(value); return { stored: true }; } }; }
export function makeAuditSink(repository) { const writes = []; return { writes, async write(value) { const record = { at: '2026-07-26T00:00:00.000Z', ...value }; writes.push(record); repository.audit.push(record); } }; }
export function makeProbe(repository) { let calls = 0; return { get calls() { return calls; }, decision(connectionId, subject) { calls += 1; return repository.listGrants(connectionId).some(x => x.subject === subject) ? 'allowed' : 'denied'; } }; }
export function makeLogger() { const entries = []; return { entries, info(value) { entries.push(value); } }; }
