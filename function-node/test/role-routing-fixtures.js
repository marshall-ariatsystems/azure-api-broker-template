'use strict';
// Frozen role-routing fixtures — deterministic, in-process, no network/Azure/topology.
const ROLE_MAP = Object.freeze({
  'VendorApi.KeyA.Invoke': 'vendor-key-a',
  'VendorApi.Graph.Invoke': Object.freeze({ secret: 'vendor-key-graph', baseUrl: 'https://vendor.test' }),
  'VendorApi.Orders.Invoke': Object.freeze({ secret: 'vendor-key-orders', route: 'orders' }),
});
const EXPECTED_SLUG_TO_ROLE = Object.freeze({
  keya: 'VendorApi.KeyA.Invoke',
  graph: 'VendorApi.Graph.Invoke',
  orders: 'VendorApi.Orders.Invoke',
});
const EXPECTED_CONNECTION_IDS = Object.freeze(['azure:keya', 'azure:graph', 'azure:orders']);
const AMBIGUOUS_ROLE_MAP = Object.freeze({
  'VendorApi.Graph.Invoke': 'vendor-key-graph',
  'VendorApi.GraphAlt.Invoke': Object.freeze({ secret: 'vendor-key-graph-alt', route: 'graph' }),
});
const TTL_DEFAULT_SECONDS = 300;
const TTL_CEILING_SECONDS = 86_400;
const TTL_VALID = Object.freeze(['30', '300', '3600', '86400']);
const TTL_INVALID = Object.freeze(['0', '-5', '5.5', 'abc', '', ' ', '1e3', '300s', '99999999']);
const FORBIDDEN_TOPOLOGY = Object.freeze([
  'func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net',
  '10.0.0.10', 'ce485d55-f7af-40a8-b9d3-12dd64252740',
]);
module.exports = Object.freeze({
  ROLE_MAP, EXPECTED_SLUG_TO_ROLE, EXPECTED_CONNECTION_IDS, AMBIGUOUS_ROLE_MAP,
  TTL_DEFAULT_SECONDS, TTL_CEILING_SECONDS, TTL_VALID, TTL_INVALID, FORBIDDEN_TOPOLOGY,
});
