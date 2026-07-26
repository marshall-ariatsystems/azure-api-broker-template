// azure-reference-adapter.js — compatibility authority for the Azure role map.

const { createConnection } = require('./hosted-authority');

function slugForRole(role, entry) {
  if (entry && typeof entry === 'object' && entry.route) return String(entry.route).toLowerCase();
  const match = /^VendorApi\.(.+)\.Invoke$/i.exec(role);
  return (match ? match[1] : role).toLowerCase();
}

function createAzureReferenceAdapter(roleMap) {
  const entries = Object.freeze(Object.entries(roleMap || {}));
  const rolesByConnectionId = new Map(entries.map(([role, entry]) => [`azure:${slugForRole(role, entry)}`, role]));
  const connectionIds = Object.freeze([...rolesByConnectionId.keys()]);
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
      id: `azure:${slugForRole(role, entry)}`,
      provider: 'azure-reference',
      baseUrl: String(vendor.baseUrl || '').replace(/\/+$/, ''),
      injection: String(vendor.inject || ''),
    });
  }

  return Object.freeze({ policy, connectionForRole, connectionIds });
}

module.exports = { createAzureReferenceAdapter };
