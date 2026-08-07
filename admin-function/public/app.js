'use strict';

const API = '/api/v1';
const state = { dashboard: null, connections: [], principals: [], events: [], branding: null, selected: null };
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function api(path, options = {}) {
  const started = performance.now();
  const response = await fetch(`${API}${path}`, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  let value = {};
  try { value = await response.json(); } catch { /* no body */ }
  if (!response.ok) throw new Error(value.error || `${response.status} ${response.statusText}`);
  $('api-status').textContent = `${response.headers.get('x-api-version') || 'v1'} · ${Math.round(performance.now() - started)}ms`;
  $('api-status').className = 'pill pill-ok';
  return value;
}

function flash(message, error = false) {
  const target = $('flash'); target.textContent = message; target.className = `flash ${error ? 'error' : ''}`; target.hidden = false;
  window.clearTimeout(flash.timer); flash.timer = window.setTimeout(() => { target.hidden = true; }, 5000);
}

function applyBranding(branding) {
  state.branding = branding;
  document.title = `${branding.productName} · Control plane`;
  $('brand-name').textContent = branding.productName;
  const logo = $('brand-logo'); logo.hidden = !branding.logoUrl; if (branding.logoUrl) logo.src = branding.logoUrl;
  if (branding.faviconUrl) $('brand-favicon').href = branding.faviconUrl;
  const links = [['docs-link', branding.documentationUrl], ['support-link', branding.supportUrl]];
  for (const [id, url] of links) { const link = $(id); link.hidden = !url; if (url) { link.href = url; link.target = '_blank'; link.rel = 'noreferrer'; } }
  document.documentElement.style.setProperty('--bg', branding.colors.background);
  document.documentElement.style.setProperty('--surface', branding.colors.surface);
  document.documentElement.style.setProperty('--accent', branding.colors.accent);
  document.documentElement.style.setProperty('--text', branding.colors.text);
}

function principalName(id) { return state.principals.find((item) => item.id === id)?.displayName || id; }
function connectionById(id) { return state.connections.find((item) => item.id === id); }
function daysSince(value) { return value ? `${Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86400000))}d` : 'never'; }

function renderOverview() {
  const metrics = state.dashboard?.metrics || {};
  $('metric-active').textContent = metrics.deployedKeys ?? 0;
  $('metric-disabled').textContent = metrics.disabledKeys ?? 0;
  $('metric-users').textContent = metrics.usersWithKeys ?? 0;
  $('metric-rotation').textContent = metrics.longestWithoutRotation ? daysSince(metrics.longestWithoutRotation.lastRotatedAt) : '—';
  $('connection-summary').innerHTML = state.connections.length ? state.connections.map((item) => `<button class="record" data-open="${esc(item.id)}"><span><strong>${esc(item.displayName)}</strong><small>${esc(item.vendor)} · ${esc(item.id)}</small></span><span class="pill ${item.enabled ? 'pill-ok' : 'pill-err'}">${esc(item.status)}</span></button>`).join('') : '<p class="empty">No broker routes are configured.</p>';
  document.querySelectorAll('[data-open]').forEach((button) => { button.onclick = () => { showView('connections'); selectConnection(button.dataset.open); }; });
}

function renderConnections() {
  const needle = $('connection-filter').value.trim().toLowerCase();
  const status = $('connection-status').value;
  const values = state.connections.filter((item) => (status === 'all' || item.status === status) && (!needle || `${item.displayName} ${item.vendor} ${item.id}`.toLowerCase().includes(needle)));
  $('connections-list').innerHTML = values.length ? values.map((item) => `<button class="record ${state.selected === item.id ? 'selected' : ''}" data-connection="${esc(item.id)}"><span><strong>${esc(item.displayName)}</strong><small>${esc(item.vendor)} · Key Vault</small></span><span class="pill ${item.enabled ? 'pill-ok' : 'pill-err'}">${esc(item.status)}</span></button>`).join('') : '<p class="empty">No routes match this filter.</p>';
  document.querySelectorAll('[data-connection]').forEach((button) => { button.onclick = () => selectConnection(button.dataset.connection); });
}

async function selectConnection(id) {
  state.selected = id; renderConnections();
  const target = $('connection-detail'); target.innerHTML = '<p class="empty">Loading route…</p>';
  try {
    const { connection, grant } = await api(`/connections/${encodeURIComponent(id)}`);
    const groups = [['Users', 'user', grant.subjects || []], ['Groups', 'group', grant.groups || []], ['Applications', 'workload', grant.workloads || []]];
    target.innerHTML = `<div class="detail-head"><div><h2>${esc(connection.displayName)}</h2><p>${esc(connection.vendor)} · ${esc(connection.id)}</p></div><button id="toggle-connection" class="btn ${connection.enabled ? 'btn-danger' : 'btn-primary'}">${connection.enabled ? 'Disable' : 'Enable'}</button></div>
      <dl><dt>Entra app role</dt><dd><code>${esc(connection.role)}</code></dd><dt>Key Vault provider</dt><dd>${esc(connection.provider)}</dd><dt>Last credential rotation</dt><dd>${connection.lastRotatedAt ? esc(new Date(connection.lastRotatedAt).toLocaleString()) : 'Not recorded'}</dd></dl>
      <section class="action"><h3>Rotate credential</h3><p>The value creates a new Key Vault version and is never returned.</p><form id="rotation-form" class="inline-form"><input id="credential-value" type="password" autocomplete="new-password" required placeholder="New credential"><button class="btn btn-primary">Write new version</button></form></section>
      <section class="action"><h3>Connection grants</h3>${groups.map(([label, kind, values]) => `<div class="grant-group"><strong>${label}</strong>${values.length ? values.map((value) => `<span class="grant">${esc(principalName(value))}<button data-remove-kind="${kind}" data-remove-subject="${esc(value)}" title="Remove">×</button></span>`).join('') : '<span class="muted">None</span>'}</div>`).join('')}<form id="grant-form" class="inline-form"><select id="grant-kind"><option value="user">User</option><option value="group">Group</option><option value="workload">Application</option></select><select id="grant-subject" required></select><button class="btn btn-primary">Grant</button></form></section>`;
    $('toggle-connection').onclick = async () => mutate(`/connections/${encodeURIComponent(id)}/status`, { enabled: !connection.enabled }, `${connection.enabled ? 'Disabled' : 'Enabled'} ${connection.displayName}.`);
    $('rotation-form').onsubmit = async (event) => { event.preventDefault(); const value = $('credential-value').value; await mutate(`/connections/${encodeURIComponent(id)}/credential`, { credential: value }, 'Credential rotated and removed from this form.'); $('credential-value').value = ''; };
    const updateSubjects = () => { const kind = $('grant-kind').value; const prefix = `${kind}:`; const values = state.principals.filter((item) => item.id.startsWith(prefix)); $('grant-subject').innerHTML = `<option value="">Select ${kind}</option>${values.map((item) => `<option value="${esc(item.id)}">${esc(item.displayName)}</option>`).join('')}`; };
    $('grant-kind').onchange = updateSubjects; updateSubjects();
    $('grant-form').onsubmit = async (event) => { event.preventDefault(); const subject = $('grant-subject').value; if (!subject) return; await mutate(`/connections/${encodeURIComponent(id)}/grants`, { kind: $('grant-kind').value, subject }, 'Grant added.'); };
    document.querySelectorAll('[data-remove-kind]').forEach((button) => { button.onclick = () => mutate(`/connections/${encodeURIComponent(id)}/grants`, { kind: button.dataset.removeKind, subject: button.dataset.removeSubject }, 'Grant removed.', 'DELETE'); });
  } catch (error) { target.innerHTML = `<p class="empty error-text">${esc(error.message)}</p>`; }
}

function renderPrincipals() {
  $('principals-list').innerHTML = state.principals.length ? state.principals.map((item) => `<div class="record static"><span><strong>${esc(item.displayName)}</strong><small>${esc(item.id)}</small></span><span class="pill">${esc(item.id.split(':')[0])}</span></div>`).join('') : '<p class="empty">No friendly principal labels have been added.</p>';
}

function renderAudit() {
  $('audit-list').innerHTML = state.events.length ? state.events.slice(0, 200).map((event) => `<div class="record static"><span><strong>${esc(event.action)}</strong><small>${esc(new Date(event.at).toLocaleString())} · ${esc(event.connectionId || event.route || '')}</small></span><span class="pill">${esc(event.outcome || event.clientStatus || '')}</span></div>`).join('') : '<p class="empty">No retained events.</p>';
}

function renderBrandingForm() {
  const b = state.branding; if (!b) return;
  $('branding-product').value = b.productName; $('branding-short').value = b.shortName; $('branding-logo').value = b.logoUrl; $('branding-favicon').value = b.faviconUrl; $('branding-docs').value = b.documentationUrl; $('branding-support').value = b.supportUrl;
  for (const name of ['background', 'surface', 'accent', 'text']) $(`color-${name}`).value = b.colors[name];
}

async function mutate(path, body, message, method = 'POST') {
  try { await api(path, { method, body: JSON.stringify(body) }); flash(message); await loadAll(); if (state.selected) await selectConnection(state.selected); } catch (error) { flash(error.message, true); }
}

async function loadAll() {
  try {
    const branding = await api('/config/branding'); applyBranding(branding.branding); renderBrandingForm();
    const identityResponse = await fetch('/.auth/me', { credentials: 'same-origin' });
    const identities = identityResponse.ok ? await identityResponse.json() : [];
    const signedIn = Array.isArray(identities) && identities.length > 0;
    $('sign-in').hidden = signedIn; $('sign-out').hidden = !signedIn;
    if (!signedIn) { $('api-status').textContent = 'sign in required'; $('api-status').className = 'pill pill-warn'; return; }
    const [dashboard, principals, logs] = await Promise.all([api('/dashboard'), api('/principals'), api('/logs')]);
    state.dashboard = dashboard; state.connections = dashboard.connections || []; state.principals = principals.principals || []; state.events = logs.events || [];
    renderOverview(); renderConnections(); renderPrincipals(); renderAudit(); renderBrandingForm();
  } catch (error) { $('api-status').textContent = 'unavailable'; $('api-status').className = 'pill pill-err'; flash(error.message, true); }
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('current', view.id === `view-${name}`));
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  history.replaceState({}, '', name === 'overview' ? '/console' : `/console#${name}`);
}

document.querySelectorAll('[data-view]').forEach((button) => { button.onclick = () => showView(button.dataset.view); });
document.querySelectorAll('[data-refresh]').forEach((button) => { button.onclick = loadAll; });
$('connection-filter').oninput = renderConnections; $('connection-status').onchange = renderConnections;
$('new-connection').onclick = () => $('connection-dialog').showModal();
$('create-connection').onclick = async (event) => {
  event.preventDefault(); const vendor = $('new-vendor').value.trim().toLowerCase(); const rolePart = vendor.replace(/(^|-)[a-z]/g, (part) => part.replace('-', '').toUpperCase());
  await mutate('/connections', { role: `VendorApi.${rolePart}.Invoke`, secret: $('new-secret').value.trim(), displayName: $('new-display').value.trim(), vendor, baseUrl: $('new-base-url').value.trim(), inject: $('new-inject').value }, 'Route created. Add the Entra app role before granting callers.');
  $('connection-dialog').close(); $('connection-form').reset();
};
$('principal-form').onsubmit = async (event) => { event.preventDefault(); await mutate('/principals', { id: `${$('principal-kind').value}:${$('principal-object-id').value.trim()}`, displayName: $('principal-name').value.trim() }, 'Principal saved.'); $('principal-form').reset(); };
$('branding-form').onsubmit = async (event) => { event.preventDefault(); await mutate('/config/branding', { productName: $('branding-product').value, shortName: $('branding-short').value, logoUrl: $('branding-logo').value, faviconUrl: $('branding-favicon').value, documentationUrl: $('branding-docs').value, supportUrl: $('branding-support').value, colors: Object.fromEntries(['background', 'surface', 'accent', 'text'].map((name) => [name, $(`color-${name}`).value])) }, 'Branding updated.'); };

showView(location.hash.slice(1) || 'overview');
loadAll();
