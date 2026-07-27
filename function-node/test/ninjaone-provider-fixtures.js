'use strict';
// Frozen ninjaone provider/deployment fixtures — tenant-neutral, no real topology.

const ENTRA_PROFILE = JSON.stringify(Object.freeze({
  provider: 'ninjaone',
  routeSlug: 'ninjaone',
  authMode: 'entra',
  audienceShape: 'api://<broker-app-id>/.default',
  handoffKind: 'signed-registration-package',
}));
const OIDC_PROFILE = JSON.stringify(Object.freeze({
  provider: 'ninjaone',
  routeSlug: 'ninjaone',
  authMode: 'oidc',
  audienceShape: 'https://<issuer>/ (aud: <broker-audience>, scope: <broker-scope>)',
  handoffKind: 'signed-registration-package',
}));
const ROLE = 'VendorApi.Ninjaone.Invoke';
const CONNECTION_ID = 'azure:ninjaone';
const ROLE_SECRET_MAP = Object.freeze({
  'VendorApi.Ninjaone.Invoke': Object.freeze({
    secret: 'ninjaone-vendor-slot',
    route: 'ninjaone',
    baseUrl: 'https://vendor.example.test',
    inject: 'oauth2cc',
  }),
});
const GRANTS = JSON.stringify(Object.freeze({
  version: 1,
  connections: Object.freeze([
    Object.freeze({ id: 'azure:ninjaone', subjects: Object.freeze(['user:00000000-0000-0000-0000-000000000000']) }),
  ]),
}));
const COMPLETE_CHAIN = Object.freeze({
  profile: ENTRA_PROFILE,
  assignedRoles: Object.freeze(['VendorApi.Ninjaone.Invoke']),
  roleSecretMap: ROLE_SECRET_MAP,
  connectionGrantsJson: GRANTS,
});
const MISSING_CLASSES = Object.freeze(['role', 'route', 'role-secret-map', 'secret-slot', 'connection-grant']);
const FORBIDDEN_TOPOLOGY = Object.freeze([
  'func-broker-cxapi-csb2cscrdcdka3fy.' + 'centralus-01.azurewebsites.net',
  '10.0.0.' + '10',
  'ce485d55-f7af-40a8-b9d3-' + '12dd64252740',
]);

module.exports = Object.freeze({
  ENTRA_PROFILE, OIDC_PROFILE, ROLE, CONNECTION_ID, ROLE_SECRET_MAP, GRANTS,
  COMPLETE_CHAIN, MISSING_CLASSES, FORBIDDEN_TOPOLOGY,
});
