(() => {
  const originalRenderDetails = renderDetails;
  const escText = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const templateDefinitions = Object.freeze({
    api_key: { label: 'API key', description: 'A single vendor API key.', fields: [{ id: 'key-value', label: 'API key', type: 'password' }], value: () => document.getElementById('key-value').value },
    bearer_token: { label: 'Bearer token', description: 'A single opaque bearer token.', fields: [{ id: 'token-value', label: 'Bearer token', type: 'password' }], value: () => document.getElementById('token-value').value },
    basic_pair: { label: 'Basic authentication pair', description: 'Stores a client/key ID and secret as one atomic JSON value.', fields: [{ id: 'pair-id', label: 'Client or key ID', type: 'text' }, { id: 'pair-secret', label: 'Client or key secret', type: 'password' }], value: () => JSON.stringify({ keyId: document.getElementById('pair-id').value, secret: document.getElementById('pair-secret').value }) },
    oauth_client_credentials: { label: 'OAuth client credentials', description: 'Stores client ID and client secret as one atomic JSON value.', fields: [{ id: 'oauth-id', label: 'Client ID', type: 'text' }, { id: 'oauth-secret', label: 'Client secret', type: 'password' }], value: () => JSON.stringify({ keyId: document.getElementById('oauth-id').value, secret: document.getElementById('oauth-secret').value }) },
  });
  const principalProfiles = new Map();
  async function loadPrincipalProfiles() {
    const result = await api('/api/principals');
    principalProfiles.clear();
    for (const item of result.principals || []) principalProfiles.set(item.id, item.displayName || item.id);
    return principalProfiles;
  }
  function principalLabel(id) { return principalProfiles.get(id) || id; }
  function templateFields() {
    const type = document.getElementById('credential-template').value;
    const definition = templateDefinitions[type];
    const target = document.getElementById('template-fields');
    target.innerHTML = `<p class="sub">${escText(definition.description)} Tessera never displays the submitted value.</p>${definition.fields.map((field) => `<label><span>${field.label}</span><input id="${field.id}" type="${field.type}" autocomplete="${field.type === 'password' ? 'new-password' : 'off'}" required></label>`).join('')}`;
  }
  function scopeOptions(kind, grants) {
    const values = kind === 'user' ? grants.subjects : kind === 'group' ? grants.groups : grants.workloads;
    return (values || []).map((value) => `<option value="${escText(value)}">${escText(principalLabel(value))}</option>`).join('');
  }
  renderDetails = function guidedRenderDetails() {
    originalRenderDetails();
    const form = document.getElementById('rotate');
    if (!form || !state.selected) return;
    const grants = state.detail?.grant || { subjects: [], groups: [], workloads: [] };
    form.innerHTML = `<label><span>Import template</span><select id="credential-template">${Object.entries(templateDefinitions).map(([value, definition]) => `<option value="${value}">${definition.label}</option>`).join('')}</select></label><div id="template-fields"></div><button>Review import</button>`;
    templateFields();
    document.getElementById('credential-template').addEventListener('change', templateFields);
    form.onsubmit = (event) => {
      event.preventDefault();
      const type = document.getElementById('credential-template').value;
      const credential = templateDefinitions[type].value();
      if (!credential || credential === '{"keyId":"","secret":""}') return document.querySelector('#template-fields input')?.focus();
      confirm({ type: 'rotate', credential, title: `Import ${templateDefinitions[type].label}?`, copy: 'This writes a new Key Vault version using the selected template. The submitted value cannot be read back.', review: `Key: ${state.selected.id}\nTemplate: ${templateDefinitions[type].label}` });
    };
    const subject = document.getElementById('subject');
    const kind = document.getElementById('kind');
    if (!subject || !kind) return;
    const picker = document.createElement('select');
    picker.id = 'subject';
    picker.required = true;
    subject.replaceWith(picker);
    const updatePrincipalChoices = () => { const values = scopeOptions(kind.value, grants); picker.innerHTML = `<option value="" selected disabled>${kind.value === 'user' ? 'Select a user scope' : kind.value === 'group' ? 'Select a group scope' : 'Select a workload scope'}</option>${values}`; };
    kind.addEventListener('change', updatePrincipalChoices);
    updatePrincipalChoices();
    loadPrincipalProfiles().then(updatePrincipalChoices).catch(() => undefined);
    const grantValues = state.detail?.grant || { subjects: [], groups: [], workloads: [] };
    [...document.querySelectorAll('#key-details .grants code')].forEach((node, index) => {
      const values = [grantValues.subjects, grantValues.groups, grantValues.workloads][index] || [];
      node.innerHTML = values.length ? values.map((value) => `<span title="${escText(value)}">${escText(principalLabel(value))}</span>`).join(', ') : 'None';
    });
    loadPrincipalProfiles().then(() => {
      [...document.querySelectorAll('#key-details .grants code')].forEach((node, index) => {
        const values = [grantValues.subjects, grantValues.groups, grantValues.workloads][index] || [];
        node.innerHTML = values.length ? values.map((value) => `<span title="${escText(value)}">${escText(principalLabel(value))}</span>`).join(', ') : 'None';
      });
    }).catch(() => undefined);
    [...document.querySelectorAll('#key-details dt')].forEach((term) => {
      if (term.textContent === 'Provider') { term.textContent = 'Vendor'; term.nextElementSibling.textContent = state.selected.vendor || state.selected.displayName; }
    });
  };
  loadLogs = async function guidedLoadLogs() {
    const target = document.getElementById('logs-list');
    target.innerHTML = '<li class="empty">Loading logs…</li>';
    try {
      const events = (await api('/api/logs')).events;
      target.innerHTML = events.length ? events.map((event) => {
        const isBrokerCall = event.action === 'broker.api.call';
        const isClientCall = event.action === 'client.api.call';
        const metadata = isBrokerCall
          ? `${escText(event.method)} /${escText(event.route)} · ${escText(event.outcome)} · ${escText(event.durationMs)}ms`
          : isClientCall ? `${escText(event.method)} ${escText(event.apiPath)} · ${escText(event.clientStatus)} · ${escText(event.clientDurationMs)}ms · page ${escText(event.pagePath)}`
          : `${escText(event.connectionId)} · ${escText(event.actor)} · ${escText(event.outcome)}`;
        const content = isBrokerCall ? `<details><summary>Delivery content${event.requestTruncated || event.responseTruncated ? ' (truncated)' : ''}</summary><p><strong>Request</strong></p><pre>${escText(event.requestContent || '(empty)')}</pre><p><strong>Response</strong></p><pre>${escText(event.responseContent || '(empty)')}</pre></details>` : '';
        return `<li><strong>${escText(event.action)}</strong><br><small>${escText(new Date(event.at).toLocaleString())} · ${metadata}</small>${content}</li>`;
      }).join('') : '<li class="empty">No operator events recorded.</li>';
    } catch { target.innerHTML = '<li class="empty">Logs are unavailable.</li>'; }
  };
  const originalRenderOverview = renderOverview;
  renderOverview = function monitoredOverview() {
    originalRenderOverview();
    if (document.getElementById('monitoring-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'monitoring-panel';
    panel.className = 'panel';
    panel.style.marginTop = '1rem';
    panel.innerHTML = '<div class="panel-head"><div><h2>Security consistency monitoring</h2><p>Checks recent browser and broker calls for unexpected locations, failures, and slow delivery.</p></div><button class="secondary" id="refresh-monitoring">Refresh checks</button></div><div id="monitoring-results" style="padding:1rem">Loading monitoring checks…</div>';
    document.getElementById('view-overview').append(panel);
    document.getElementById('refresh-monitoring').onclick = loadMonitoring;
    loadMonitoring();
  };
  async function loadMonitoring() {
    const target = document.getElementById('monitoring-results');
    if (!target) return;
    target.textContent = 'Loading monitoring checks…';
    try {
      const result = await api('/api/monitoring');
      const alerts = result.alerts || [];
      target.innerHTML = `<p><strong>${result.summary.high} high</strong> and <strong>${result.summary.medium} medium</strong> findings across ${result.summary.scanned} recent records.</p>${alerts.length ? `<ul class="records">${alerts.map((alert) => `<li><strong>${escText(alert.severity)} · ${escText(alert.type)}</strong><br><small>${escText(alert.at)} · ${escText(alert.detail)}</small></li>`).join('')}</ul>` : '<p>No inconsistencies detected in the retained event window.</p>'}`;
    } catch { target.textContent = 'Monitoring checks are unavailable.'; }
  }
  function vendorKeyButton(key) {
    return `<li><button data-key="${escText(key.id)}" aria-current="${key.id === state.selected?.id}"><span><span class="name">${escText(key.displayName || key.id)}</span><span class="sub">Vendor: ${escText(key.vendor || 'Unassigned')} · vault key ${escText(key.displayName || key.id)} · rotated ${key.lastRotatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(key.lastRotatedAt)) / 86400000)) + 'd' : 'Not recorded'}</span></span><span class="chip ${key.enabled ? '' : 'disabled'}">${escText(key.status)}</span></button></li>`;
  }
  function ensureVendorControls() {
    const header = document.querySelector('#view-keys .panel-head');
    if (!header || document.getElementById('vendor-filter')) return;
    const status = document.getElementById('key-filter');
    const add = document.createElement('button'); add.id = 'add-key'; add.className = 'secondary'; add.textContent = 'Add key';
    const vendor = document.createElement('select'); vendor.id = 'vendor-filter'; vendor.setAttribute('aria-label', 'Filter keys by vendor');
    const sort = document.createElement('select'); sort.id = 'key-sort'; sort.setAttribute('aria-label', 'Sort keys');
    sort.innerHTML = '<option value="vendor">Sort: Vendor</option><option value="name">Sort: Vault name</option><option value="status">Sort: Status</option>';
    status.before(add); status.before(vendor); status.before(sort);
    add.onclick = () => selectKey('new', true);
    vendor.addEventListener('change', renderKeys); sort.addEventListener('change', renderKeys);
  }
  renderKeys = function vendorRenderKeys() {
    ensureVendorControls();
    const status = document.getElementById('key-filter')?.value || 'active';
    const vendorControl = document.getElementById('vendor-filter');
    const sort = document.getElementById('key-sort')?.value || 'vendor';
    const vendors = [...new Set((state.data?.connections || []).map((key) => key.vendor || 'Unassigned'))].sort((a, b) => a.localeCompare(b));
    if (vendorControl) {
      const selected = vendorControl.value || 'all';
      vendorControl.innerHTML = `<option value="all">All vendors</option>${vendors.map((value) => `<option value="${escText(value)}">${escText(value)}</option>`).join('')}`;
      vendorControl.value = vendors.includes(selected) ? selected : 'all';
    }
    const vendor = vendorControl?.value || 'all';
    const keys = (state.data?.connections || []).filter((key) => (status === 'all' || key.status === status) && (vendor === 'all' || (key.vendor || 'Unassigned') === vendor)).sort((a, b) => {
      if (sort === 'name') return (a.displayName || a.id).localeCompare(b.displayName || b.id);
      if (sort === 'status') return a.status.localeCompare(b.status) || (a.vendor || '').localeCompare(b.vendor || '');
      return (a.vendor || '').localeCompare(b.vendor || '') || (a.displayName || a.id).localeCompare(b.displayName || b.id);
    });
    const list = document.getElementById('key-list');
    if (list) { list.innerHTML = keys.length ? keys.map(vendorKeyButton).join('') : '<li class="empty">No keys match these selected values.</li>'; document.querySelectorAll('[data-key]').forEach((button) => { button.onclick = () => selectKey(button.dataset.key, true); }); }
  };
  renderKeys();
  const originalRenderPrincipals = renderPrincipals;
  renderPrincipals = async function guidedRenderPrincipals(view) {
    const target = document.getElementById(view === 'users' ? 'users-list' : 'groups-list');
    target.innerHTML = '<p class="empty">Loading scopes…</p>';
    try {
      const [map] = await Promise.all([loadPrincipals(view), loadPrincipalProfiles()]);
      target.innerHTML = map.size ? [...map].map(([id, keys]) => `<article class="panel summary-card"><h3>${escText(principalLabel(id))}</h3><p><small title="${escText(id)}">${escText(id)}</small></p><p>${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys.map(escText).join(', ')}</p></article>`).join('') : '<p class="empty">No matching scopes are configured.</p>';
    } catch {
      originalRenderPrincipals(view);
    }
  };
  const originalSelectKey = selectKey;
  async function renderNewKey() {
    const target = document.getElementById('key-details');
    target.innerHTML = '<p class="empty">Loading vendor profiles…</p>';
    let vendors = [];
    try { vendors = (await api('/api/vendors')).vendors || []; } catch { /* The screen remains usable with a manual vendor identifier. */ }
    target.innerHTML = `<div class="title"><div><h2>Add an API key</h2><p>Start a governed key provisioning request. Credentials are never entered on this screen.</p></div></div><form id="new-key-form"><label><span>Vendor</span><select id="new-key-vendor"><option value="">Select an existing vendor</option>${vendors.map((vendor) => `<option value="${escText(vendor.id)}">${escText(vendor.displayName)}</option>`).join('')}</select></label><label><span>Key display name</span><input id="new-key-name" required maxlength="128" placeholder="Example: production integration"></label><label><span>Credential type</span><select id="new-key-type">${Object.entries(templateDefinitions).map(([id, definition]) => `<option value="${escText(id)}">${escText(definition.label)}</option>`).join('')}</select></label><div class="row"><button>Generate provisioning plan</button></div></form><section class="action" style="margin-top:1rem"><h3>What happens next</h3><p>Use the Tessera CLI’s explicit vendor provisioning command to create the Entra role, write the initial Key Vault secret, and grant broker-only secret read access. Then return here to rotate credentials and manage user or group scopes.</p></section>`;
    document.getElementById('new-key-form').onsubmit = (event) => {
      event.preventDefault();
      const vendor = vendors.find((item) => item.id === document.getElementById('new-key-vendor').value);
      const displayName = document.getElementById('new-key-name').value.trim();
      if (!vendor || !displayName) return document.getElementById('new-key-vendor').focus();
      const role = `VendorApi.${vendor.id.replace(/(^|-)\w/g, (part) => part.replace('-', '').toUpperCase())}.Invoke`;
      const secret = `${vendor.id}-${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`;
      target.querySelector('#new-key-form').insertAdjacentHTML('afterend', `<section class="action" style="margin-top:1rem"><h3>Provisioning plan</h3><dl><dt>Vendor</dt><dd>${escText(vendor.displayName)}</dd><dt>Credential</dt><dd>${escText(templateDefinitions[document.getElementById('new-key-type').value].label)}</dd><dt>Entra role</dt><dd>${escText(role)}</dd><dt>Key Vault secret</dt><dd>${escText(secret)}</dd></dl><p class="sub">After the Entra role and Key Vault secret are approved and created, add this role-map entry and then import the credential from that key’s page.</p></section>`);
      say('Provisioning plan generated. No key or credential was created.');
    };
  }
  selectKey = async function guidedSelectKey(id, route) {
    if (id !== 'new') return originalSelectKey(id, route);
    state.selected = null; state.detail = null;
    if (route) history.pushState({}, '', '/console/keys/new');
    nav('keys'); renderKeys();
    await renderNewKey();
  };
  const originalNav = nav;
  nav = function vendorNav(view) {
    if (view !== 'vendors') return originalNav(view);
    document.querySelectorAll('.view').forEach((node) => { node.hidden = node.id !== 'view-vendors'; });
    document.querySelectorAll('[data-view]').forEach((node) => node.setAttribute('aria-current', String(node.dataset.view === 'vendors')));
    document.getElementById('page-title').textContent = 'Vendors';
    document.getElementById('page-subtitle').textContent = 'Manage non-secret vendor profiles, assigned keys, and vendor-specific delivery history.';
    loadVendors();
  };
  const navList = document.querySelector('.nav');
  const vendorNavButton = document.createElement('button');
  vendorNavButton.dataset.view = 'vendors';
  vendorNavButton.innerHTML = '<span class="icon">◇</span><span class="label">Vendors</span>';
  vendorNavButton.onclick = () => nav('vendors');
  navList.insertBefore(vendorNavButton, navList.querySelector('[data-view="logs"]'));
  const vendorView = document.createElement('section');
  vendorView.id = 'view-vendors'; vendorView.className = 'view'; vendorView.hidden = true;
  vendorView.innerHTML = '<div class="workspace"><div class="panel"><div class="panel-head"><div><h2>Vendor profiles</h2><p>Non-secret connection metadata</p></div><button id="new-vendor" class="secondary">Add vendor</button></div><ul id="vendor-list" class="keys"></ul></div><div class="panel"><div id="vendor-details" class="details"><p class="empty">Select a vendor to view its profile, assigned keys, and delivery history.</p></div></div></div>';
  document.querySelector('.main').append(vendorView);
  document.getElementById('new-vendor').onclick = () => editVendor({ id: '', displayName: '', authType: 'api-key', keys: [] });
  let vendorState = [];
  async function loadVendors() {
    const list = document.getElementById('vendor-list'); list.innerHTML = '<li class="empty">Loading vendors…</li>';
    try {
      vendorState = (await api('/api/vendors')).vendors;
      list.innerHTML = vendorState.length ? vendorState.map((vendor) => `<li><button data-vendor-id="${escText(vendor.id)}"><span><span class="name">${escText(vendor.displayName)}</span><span class="sub">${vendor.keys.length} assigned key${vendor.keys.length === 1 ? '' : 's'} · ${escText(vendor.authType || 'authentication not set')}</span></span><span class="chip">${vendor.keys.length}</span></button></li>`).join('') : '<li class="empty">No vendors configured.</li>';
      document.querySelectorAll('[data-vendor-id]').forEach((button) => { button.onclick = () => editVendor(vendorState.find((vendor) => vendor.id === button.dataset.vendorId)); });
    } catch { list.innerHTML = '<li class="empty">Vendors are unavailable.</li>'; }
  }
  async function vendorLogs(vendor) {
    try {
      const events = (await api('/api/logs')).events.filter((event) => String(event.route || '').toLowerCase().includes(vendor.id) || String(event.connectionId || '').toLowerCase().includes(vendor.id)).slice(0, 20);
      return events.length ? `<ul class="records">${events.map((event) => `<li><strong>${escText(event.action)}</strong><br><small>${escText(event.at)} · ${escText(event.method || '')} ${escText(event.route || event.connectionId || '')} · ${escText(event.outcome)}</small></li>`).join('')}</ul>` : '<p class="sub">No vendor-specific delivery records in the retained window.</p>';
    } catch { return '<p class="sub">Vendor logs are unavailable.</p>'; }
  }
  async function editVendor(vendor) {
    const target = document.getElementById('vendor-details');
    target.innerHTML = `<div class="title"><div><h2>${escText(vendor.displayName || 'New vendor')}</h2><p>Non-secret vendor profile</p></div></div><form id="vendor-form"><label><span>Vendor ID</span><input id="vendor-id" value="${escText(vendor.id)}" ${vendor.id ? 'readonly' : ''} required pattern="[a-z0-9][a-z0-9-]{0,63}"></label><label><span>Display name</span><input id="vendor-display" value="${escText(vendor.displayName)}" required></label><label><span>Authentication type</span><select id="vendor-auth"><option value="api-key">API key</option><option value="bearer">Bearer token</option><option value="basic">Basic pair</option><option value="oauth2cc">OAuth client credentials</option><option value="entra">Microsoft Entra ID</option></select></label><label><span>Base URL</span><input id="vendor-base" type="url" value="${escText(vendor.baseUrl || '')}" placeholder="https://api.vendor.example"></label><label><span>Documentation URL</span><input id="vendor-docs" type="url" value="${escText(vendor.documentationUrl || '')}" placeholder="https://docs.vendor.example"></label><div class="row"><button>Save vendor</button></div></form><section class="action" style="margin-top:1rem"><h3>Assigned keys</h3>${vendor.keys.length ? `<ul class="grants">${vendor.keys.map((key) => `<li><button class="secondary" data-assigned-key="${escText(key.id)}">${escText(key.displayName)}</button><span>${escText(key.status)}</span></li>`).join('')}</ul>` : '<p class="sub">No keys are assigned to this vendor yet.</p>'}</section><section class="action" style="margin-top:1rem"><h3>Vendor delivery logs</h3><div id="vendor-logs">Loading logs…</div></section>`;
    document.getElementById('vendor-auth').value = vendor.authType || 'api-key';
    document.getElementById('vendor-form').onsubmit = async (event) => { event.preventDefault(); const payload = { id: document.getElementById('vendor-id').value.trim(), displayName: document.getElementById('vendor-display').value.trim(), authType: document.getElementById('vendor-auth').value, baseUrl: document.getElementById('vendor-base').value.trim(), documentationUrl: document.getElementById('vendor-docs').value.trim() }; try { await api('/api/vendors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); say('Vendor profile saved.'); await loadVendors(); } catch { say('Vendor profile could not be saved.', true); } };
    document.querySelectorAll('[data-assigned-key]').forEach((button) => { button.onclick = () => { nav('keys'); selectKey(button.dataset.assignedKey, true); }; });
    document.getElementById('vendor-logs').innerHTML = await vendorLogs(vendor);
  }
})();
