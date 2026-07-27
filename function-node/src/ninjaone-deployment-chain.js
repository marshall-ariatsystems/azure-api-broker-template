'use strict';

const { parseNinjaoneProfile } = require('./ninjaone-provider-profile');
const { slugForRole, connectionIdForRole } = require('./role-routing');

const MISSING_CLASSES = Object.freeze(['role', 'route', 'role-secret-map', 'secret-slot', 'connection-grant']);
const OWN = Object.prototype.hasOwnProperty;

function fail(message) { throw new TypeError(message); }
function result(missing) {
  if (!MISSING_CLASSES.includes(missing)) fail('deployment chain is invalid');
  return Object.freeze({ ok: false, missing });
}
function structuralInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4 || !['profile', 'assignedRoles', 'roleSecretMap', 'connectionGrantsJson'].every((key) => OWN.call(input, key))) fail('deployment chain input is invalid');
  if (!Array.isArray(input.assignedRoles) || input.assignedRoles.some((role) => typeof role !== 'string' || !role || role.length > 256)) fail('assigned roles are invalid');
  if (!input.roleSecretMap || typeof input.roleSecretMap !== 'object' || Array.isArray(input.roleSecretMap)) fail('role secret map is invalid');
  if (typeof input.connectionGrantsJson !== 'string' || Buffer.byteLength(input.connectionGrantsJson, 'utf8') > 64 * 1024) fail('connection grants are invalid');
}
function grants(raw) {
  let document;
  try { document = JSON.parse(raw); } catch { fail('connection grants are invalid'); }
  if (!document || typeof document !== 'object' || Array.isArray(document) || document.version !== 1 || !Array.isArray(document.connections)) fail('connection grants are invalid');
  for (const entry of document.connections) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !entry.id || (!Array.isArray(entry.subjects) && !Array.isArray(entry.groups) && !Array.isArray(entry.workloads))) fail('connection grants are invalid');
  }
  return document.connections;
}

function validateDeploymentChain(input) {
  structuralInput(input);
  const profile = parseNinjaoneProfile(input.profile);
  const role = input.assignedRoles.find((candidate) => slugForRole(candidate).toLowerCase() === profile.routeSlug);
  if (!role) return result('role');
  if (!OWN.call(input.roleSecretMap, role)) return result('role-secret-map');
  const entry = input.roleSecretMap[role];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('role secret map is invalid');
  if (slugForRole(role, entry) !== profile.routeSlug) return result('route');
  if (entry.inject === 'entra') {
    if (typeof entry.scope !== 'string' || !entry.scope) return result('secret-slot');
  } else if (typeof entry.secret !== 'string' || !entry.secret) return result('secret-slot');
  const connectionId = connectionIdForRole(role, entry);
  if (!grants(input.connectionGrantsJson).some((grant) => grant.id === connectionId)) return result('connection-grant');
  return Object.freeze({ ok: true, route: profile.routeSlug });
}

module.exports = { slugForRole, connectionIdForRole, validateDeploymentChain };
