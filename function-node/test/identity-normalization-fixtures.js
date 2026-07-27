'use strict';
// Frozen identity/assurance/grant fixtures — deterministic, in-process, no network/IdP/KeyVault.
const KNOWN_CONNECTION_IDS = Object.freeze(['azure:orders']);
const CONNECTION = Object.freeze({ id: 'azure:orders', provider: 'azure-reference', baseUrl: 'https://vendor.test', injection: 'header' });
const SUBJECT_ONLY_GRANTS = JSON.stringify({ version: 1, connections: [{ id: 'azure:orders', subjects: ['user:DISTINCTIVE-SUBJECT-OID'] }] });
const WORKLOAD_ONLY_GRANTS = JSON.stringify({ version: 1, connections: [{ id: 'azure:orders', workloads: ['workload:DISTINCTIVE-AZP'] }] });
const EVIDENCE_NO_GROUPS = Object.freeze({});
const EVIDENCE_EMPTY_GROUPS = Object.freeze({ groups: Object.freeze([]) });
const ASSURANCE_POLICY = Object.freeze({ requiredAcr: 'urn:assurance:fido2', requiredAmr: 'hwk' });
const CLAIMS_SUFFICIENT = Object.freeze({ acr: 'urn:assurance:fido2', amr: Object.freeze(['hwk', 'user']) });
const CLAIMS_WRONG_ACR = Object.freeze({ acr: 'urn:assurance:mfa', amr: Object.freeze(['hwk']) });
const CLAIMS_AMR_MISSING = Object.freeze({ acr: 'urn:assurance:fido2', amr: Object.freeze([]) });
const CLAIMS_AMR_PARTIAL = Object.freeze({ acr: 'urn:assurance:fido2', amr: Object.freeze(['hwks']) });
const GRANT_CONFIG_MALFORMED = '{ this is not json';
const GRANT_CONFIG_OVERSIZE = '{"version":1,"connections":' + '['.repeat(4) + '"x"' + ']'.repeat(4) + '}';
const GRANT_CONFIG_WRONG_SCHEMA = JSON.stringify({ version: 2, connections: [] });
const GRANT_CONFIG_FAULT_CATEGORY = 'grant-config-invalid';
const DENIAL_OUTCOME = 'grant=denied';
module.exports = Object.freeze({ KNOWN_CONNECTION_IDS, CONNECTION, SUBJECT_ONLY_GRANTS, WORKLOAD_ONLY_GRANTS, EVIDENCE_NO_GROUPS, EVIDENCE_EMPTY_GROUPS, ASSURANCE_POLICY, CLAIMS_SUFFICIENT, CLAIMS_WRONG_ACR, CLAIMS_AMR_MISSING, CLAIMS_AMR_PARTIAL, GRANT_CONFIG_MALFORMED, GRANT_CONFIG_OVERSIZE, GRANT_CONFIG_WRONG_SCHEMA, GRANT_CONFIG_FAULT_CATEGORY, DENIAL_OUTCOME });
