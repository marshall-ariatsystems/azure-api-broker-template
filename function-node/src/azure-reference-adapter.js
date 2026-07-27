// azure-reference-adapter.js — compatibility authority for the Azure role map.

const { createConnection } = require('./hosted-authority');
const { buildRouteTable, connectionIdForRole } = require('./role-routing');

function createAzureReferenceAdapter(roleMap) {
  const entries = Object.freeze(Object.entries(roleMap || {}));
  const routeTable = buildRouteTable(roleMap || {});
  const rolesByConnectionId = new Map(entries.map(([role, entry]) => [connectionIdForRole(role, entry), role]));
  const connectionIds = routeTable.connectionIds;
  const policy = Object.freeze({
    allows(identity, connection) {
      const role = rolesByConnectionId.get(connection.id);
      return Boolean(role && Array.isArray(identity.roles) && identity.roles.includes(role));
    },
  });

  function connectionForRole(role, vendor) {
    const entry = Object.prototype.hasOwnProperty.call(roleMap || {}, role) ? roleMap[role] : undefined;
    if (!entry || !vendor) throw new TypeError('known role and vendor are required');
    return createConnection({
      id: connectionIdForRole(role, entry),
      provider: 'azure-reference',
      baseUrl: String(vendor.baseUrl || '').replace(/\/+$/, ''),
      injection: String(vendor.inject || ''),
    });
  }

  return Object.freeze({ policy, connectionForRole, connectionIds });
}

module.exports = { createAzureReferenceAdapter };
