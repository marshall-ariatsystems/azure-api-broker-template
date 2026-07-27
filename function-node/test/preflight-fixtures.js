'use strict';
// Frozen preflight fixtures — deterministic, in-process, no network/Azure/IdP.

const ROLE = 'VendorApi.Ninjaone.Invoke';
const CONNECTION_ID = 'azure:ninjaone';
const ROUTE_SLUG = 'ninjaone';
const ROLE_SECRET_MAP = Object.freeze({
  'VendorApi.Ninjaone.Invoke': Object.freeze({ secret: 'ninjaone-vendor-slot', route: 'ninjaone', baseUrl: 'https://vendor.example.test', inject: 'oauth2cc' }),
});
// Authenticated caller principals (distinctive markers must never leak to any surface).
const AUTHORIZED_PRINCIPAL = Object.freeze({ oid: 'DISTINCTIVE-OID', azp: 'DISTINCTIVE-AZP', roles: Object.freeze(['VendorApi.Ninjaone.Invoke']) });
const ROLE_DENIED_PRINCIPAL = Object.freeze({ oid: 'DISTINCTIVE-OID', azp: 'DISTINCTIVE-AZP', roles: Object.freeze(['VendorApi.Other.Invoke']) });
const WORKLOAD_PRINCIPAL = Object.freeze({ azp: 'DISTINCTIVE-AZP', roles: Object.freeze(['VendorApi.Ninjaone.Invoke']) });
// Grant document: allows the authorized caller's user subject only.
const GRANTS = JSON.stringify(Object.freeze({ version: 1, connections: Object.freeze([
  Object.freeze({ id: 'azure:ninjaone', subjects: Object.freeze(['user:DISTINCTIVE-OID']) }),
]) }));
// Grant document that grants a DIFFERENT subject (forces grant-denied for the workload caller).
const GRANTS_OTHER_SUBJECT = JSON.stringify(Object.freeze({ version: 1, connections: Object.freeze([
  Object.freeze({ id: 'azure:ninjaone', subjects: Object.freeze(['user:DISTINCTIVE-GRANT-SUBJECT']) }),
]) }));
// Correlation-id cases.
const VALID_CORRELATION = 'req-01HZ_client.abc-0001';       // matches [A-Za-z0-9._-]{8,128}
const MALFORMED_CORRELATION = 'bad id with spaces!';         // rejected -> generate a fresh one
const GENERATED_CORRELATION = 'gen-0000000000000000';        // returned by the injected id source
function createIdSource(value = GENERATED_CORRELATION) { return Object.freeze({ next: () => value }); }
function createCounters() { return { kv: 0, vendor: 0, oauth: 0, fetch: 0 }; }
const DISTINCTIVE_MARKERS = Object.freeze(['DISTINCTIVE-OID', 'DISTINCTIVE-AZP', 'DISTINCTIVE-GRANT-SUBJECT']);
const FORBIDDEN_TOPOLOGY = Object.freeze([
  'func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net', '10.0.0.10', 'ce485d55-f7af-40a8-b9d3-12dd64252740',
]);

module.exports = Object.freeze({
  ROLE, CONNECTION_ID, ROUTE_SLUG, ROLE_SECRET_MAP,
  AUTHORIZED_PRINCIPAL, ROLE_DENIED_PRINCIPAL, WORKLOAD_PRINCIPAL,
  GRANTS, GRANTS_OTHER_SUBJECT, VALID_CORRELATION, MALFORMED_CORRELATION,
  GENERATED_CORRELATION, createIdSource, createCounters, DISTINCTIVE_MARKERS, FORBIDDEN_TOPOLOGY,
});
