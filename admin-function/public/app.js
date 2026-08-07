'use strict';

const API = '/api/v1';
const state = { dashboard: null, connections: [], principals: [], events: [], branding: null, selected: null };
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function readableInk(background) {
  return contrast(background, '#061423') >= contrast(background, '#ffffff') ? '#061423' : '#ffffff';
}

function setApiStatus(label, tone = 'pending') {
  const target = $('api-status');
  target.className = `status-badge status-${tone}`;
  target.querySelector('.status-label').textContent = label;
}

function setAuthState(value) {
  document.body.dataset.authState = value;
  $('auth-callout').hidden = value !== 'anonymous';
  $('role-callout').hidden = value !== 'forbidden';
}

async function api(path, options = {}) {
  const started = performance.now();
  const response = await fetch(`${API}${path}`, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  let value = {};
  try { value = await response.json(); } catch { /* no body */ }
  if (!response.ok) {
    const error = new Error(value.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  setApiStatus(`${response.headers.get('x-api-version') || 'v1'} · ${Math.round(performance.now() - started)}ms`, 'ok');
  return value;
}

function flash(message, error = false) {
  const target = $('flash'); target.textContent = message; target.className = `toast ${error ? 'error' : ''}`; target.hidden = false;
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
  document.documentElement.style.setProperty('--accent-ink', readableInk(branding.colors.accent));
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
  $('connection-summary').innerHTML = state.connections.length ? state.connections.slice(0, 5).map((item) => `<button class="record" data-open="${esc(item.id)}"><span><strong>${esc(item.displayName)}</strong><small>${esc(item.vendor)} · ${esc(item.id)}</small></span><span class="pill ${item.enabled ? 'pill-ok' : 'pill-err'}">${esc(item.status)}</span><span class="record-chevron" aria-hidden="true">›</span></button>`).join('') : '<div class="empty-state compact"><span class="empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span><h3>No connections yet</h3><p>Add an upstream API to begin brokering access.</p><button class="btn btn-primary" type="button" data-empty-add>Add connection</button></div>';
  document.querySelectorAll('[data-open]').forEach((button) => { button.onclick = () => { showView('connections', true); selectConnection(button.dataset.open); }; });
  document.querySelectorAll('[data-empty-add]').forEach((button) => { button.onclick = () => $('connection-dialog').showModal(); });
}

function renderConnections() {
  const needle = $('connection-filter').value.trim().toLowerCase();
  const status = $('connection-status').value;
  const values = state.connections.filter((item) => (status === 'all' || item.status === status) && (!needle || `${item.displayName} ${item.vendor} ${item.id}`.toLowerCase().includes(needle)));
  $('connection-count').textContent = state.connections.length;
  $('connections-list').innerHTML = values.length ? values.map((item) => `<button class="record ${state.selected === item.id ? 'selected' : ''}" data-connection="${esc(item.id)}" aria-pressed="${state.selected === item.id}"><span><strong>${esc(item.displayName)}</strong><small>${esc(item.vendor)} · Key Vault</small></span><span class="pill ${item.enabled ? 'pill-ok' : 'pill-err'}">${esc(item.status)}</span><span class="record-chevron" aria-hidden="true">›</span></button>`).join('') : `<div class="empty-state compact"><span class="empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></span><h3>${state.connections.length ? 'No matching connections' : 'No connections yet'}</h3><p>${state.connections.length ? 'Try another search or status filter.' : 'Add your first upstream API route.'}</p></div>`;
  document.querySelectorAll('[data-connection]').forEach((button) => { button.onclick = () => selectConnection(button.dataset.connection); });
}

async function selectConnection(id) {
  state.selected = id; renderConnections();
  const target = $('connection-detail'); target.innerHTML = '<div class="loading-state"><span></span><p>Loading connection…</p></div>';
  try {
    const { connection, grant } = await api(`/connections/${encodeURIComponent(id)}`);
    const groups = [['Users', 'user', grant.subjects || []], ['Groups', 'group', grant.groups || []], ['Applications', 'workload', grant.workloads || []]];
    target.innerHTML = `<div class="detail-head"><div><span class="pill ${connection.enabled ? 'pill-ok' : 'pill-err'}">${esc(connection.status)}</span><h2>${esc(connection.displayName)}</h2><p>${esc(connection.vendor)} · ${esc(connection.id)}</p></div><button id="toggle-connection" type="button" class="btn ${connection.enabled ? 'btn-danger' : 'btn-primary'}">${connection.enabled ? 'Disable route' : 'Enable route'}</button></div>
      <dl><dt>Entra app role</dt><dd><code>${esc(connection.role)}</code></dd><dt>Credential provider</dt><dd>${esc(connection.provider)}</dd><dt>Last rotation</dt><dd>${connection.lastRotatedAt ? esc(new Date(connection.lastRotatedAt).toLocaleString()) : 'Not recorded'}</dd></dl>
      <section class="action"><h3>Rotate credential</h3><p>Creates a new Key Vault version. The value is cleared immediately and never returned.</p><form id="rotation-form" class="inline-form"><label class="sr-only" for="credential-value">New credential</label><input id="credential-value" type="password" autocomplete="new-password" required placeholder="Enter a new credential"><button class="btn btn-primary" type="submit">Write new version</button></form></section>
      <section class="action"><h3>Connection grants</h3><p>Callers also need the matching Entra app role before this grant is effective.</p>${groups.map(([label, kind, values]) => `<div class="grant-group"><strong>${label}</strong>${values.length ? values.map((value) => `<span class="grant">${esc(principalName(value))}<button type="button" data-remove-kind="${kind}" data-remove-subject="${esc(value)}" title="Remove ${esc(principalName(value))}" aria-label="Remove ${esc(principalName(value))}">×</button></span>`).join('') : '<span class="muted">None</span>'}</div>`).join('')}<form id="grant-form" class="inline-form"><label class="sr-only" for="grant-kind">Principal type</label><select id="grant-kind"><option value="user">User</option><option value="group">Group</option><option value="workload">Application</option></select><label class="sr-only" for="grant-subject">Principal</label><select id="grant-subject" required></select><button class="btn btn-primary" type="submit">Add grant</button></form></section>`;
    $('toggle-connection').onclick = async () => mutate(`/connections/${encodeURIComponent(id)}/status`, { enabled: !connection.enabled }, `${connection.enabled ? 'Disabled' : 'Enabled'} ${connection.displayName}.`);
    $('rotation-form').onsubmit = async (event) => { event.preventDefault(); const value = $('credential-value').value; await mutate(`/connections/${encodeURIComponent(id)}/credential`, { credential: value }, 'Credential rotated and removed from this form.'); $('credential-value').value = ''; };
    const updateSubjects = () => { const kind = $('grant-kind').value; const prefix = `${kind}:`; const values = state.principals.filter((item) => item.id.startsWith(prefix)); $('grant-subject').innerHTML = `<option value="">Select ${kind}</option>${values.map((item) => `<option value="${esc(item.id)}">${esc(item.displayName)}</option>`).join('')}`; };
    $('grant-kind').onchange = updateSubjects; updateSubjects();
    $('grant-form').onsubmit = async (event) => { event.preventDefault(); const subject = $('grant-subject').value; if (!subject) return; await mutate(`/connections/${encodeURIComponent(id)}/grants`, { kind: $('grant-kind').value, subject }, 'Grant added.'); };
    document.querySelectorAll('[data-remove-kind]').forEach((button) => { button.onclick = () => mutate(`/connections/${encodeURIComponent(id)}/grants`, { kind: button.dataset.removeKind, subject: button.dataset.removeSubject }, 'Grant removed.', 'DELETE'); });
  } catch (error) { target.innerHTML = `<p class="empty error-text">${esc(error.message)}</p>`; }
}

function renderPrincipals() {
  $('principal-count').textContent = state.principals.length;
  $('principals-list').innerHTML = state.principals.length ? state.principals.map((item) => `<div class="record static"><span class="principal-avatar" aria-hidden="true">${esc(item.displayName.slice(0, 2).toUpperCase())}</span><span><strong>${esc(item.displayName)}</strong><small>${esc(item.id)}</small></span><span class="pill">${esc(item.id.split(':')[0])}</span></div>`).join('') : '<div class="empty-state compact"><span class="empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8"/></svg></span><h3>No labeled principals</h3><p>Add a user, group, or application to make grants easier to recognize.</p></div>';
}

function renderAudit() {
  $('audit-count').textContent = Math.min(state.events.length, 200);
  $('audit-list').innerHTML = state.events.length ? state.events.slice(0, 200).map((event) => `<div class="record static"><span><strong>${esc(event.action)}</strong><small>${esc(event.connectionId || event.route || 'Broker control plane')} · ${esc(new Date(event.at).toLocaleString())}</small></span><span class="pill">${esc(event.outcome || event.clientStatus || 'recorded')}</span></div>`).join('') : '<div class="empty-state compact"><span class="empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11h6M9 15h6M6 3h12a2 2 0 0 1 2 2v16l-4-2-4 2-4-2-4 2V5a2 2 0 0 1 2-2Z"/></svg></span><h3>No retained events</h3><p>Administrative and broker activity will appear here.</p></div>';
}

function renderBrandingForm() {
  const b = state.branding; if (!b) return;
  $('branding-product').value = b.productName; $('branding-short').value = b.shortName; $('branding-logo').value = b.logoUrl; $('branding-favicon').value = b.faviconUrl; $('branding-docs').value = b.documentationUrl; $('branding-support').value = b.supportUrl;
  for (const name of ['background', 'surface', 'accent', 'text']) $(`color-${name}`).value = b.colors[name];
  renderBrandingPreview();
}

function renderBrandingPreview() {
  const preview = $('brand-preview');
  if (!preview) return;
  $('preview-product').textContent = $('branding-product').value || 'Product name';
  $('preview-short').textContent = $('branding-short').value || 'Short name';
  for (const name of ['background', 'surface', 'accent', 'text']) {
    const value = $(`color-${name}`).value;
    document.querySelector(`[data-color-value="${name}"]`).textContent = value.toUpperCase();
    preview.style.setProperty(`--preview-${name === 'background' ? 'bg' : name}`, value);
  }
  preview.style.setProperty('--preview-accent-ink', readableInk($('color-accent').value));
  const minimum = Math.min(contrast($('color-text').value, $('color-background').value), contrast($('color-text').value, $('color-surface').value));
  const passes = minimum >= 4.5;
  const feedback = $('contrast-feedback');
  feedback.className = `contrast-feedback ${passes ? 'ok' : 'warn'}`;
  feedback.textContent = passes ? `Text contrast passes WCAG AA (${minimum.toFixed(1)}:1 minimum).` : `Increase text contrast before saving (${minimum.toFixed(1)}:1; 4.5:1 required).`;
  $('save-branding').disabled = !passes;
}

async function mutate(path, body, message, method = 'POST') {
  try { await api(path, { method, body: JSON.stringify(body) }); flash(message); await loadAll(); if (state.selected) await selectConnection(state.selected); } catch (error) { flash(error.message, true); }
}

async function loadAll() {
  try {
    setApiStatus('Connecting', 'pending');
    const branding = await api('/config/branding'); applyBranding(branding.branding); renderBrandingForm();
    const [dashboard, principals, logs] = await Promise.all([api('/dashboard'), api('/principals'), api('/logs')]);
    $('sign-in').hidden = true; $('sign-out').hidden = false;
    setAuthState('authenticated');
    state.dashboard = dashboard; state.connections = dashboard.connections || []; state.principals = principals.principals || []; state.events = logs.events || [];
    renderOverview(); renderConnections(); renderPrincipals(); renderAudit(); renderBrandingForm();
  } catch (error) {
    if (error.status === 401) {
      $('sign-in').hidden = false; $('sign-out').hidden = true;
      setAuthState('anonymous'); setApiStatus('Sign in required', 'pending'); showView('overview');
      return;
    }
    if (error.status === 403) {
      $('sign-in').hidden = true; $('sign-out').hidden = false;
      setAuthState('forbidden'); setApiStatus('Operator role required', 'error'); showView('overview');
      flash('Your account is signed in but does not have the Broker.Operator app role.', true);
      return;
    }
    setAuthState('error'); setApiStatus('Unavailable', 'error'); flash(error.message, true);
  }
}

function setNavOpen(open) {
  document.body.classList.toggle('nav-open', open);
  $('menu-toggle').setAttribute('aria-expanded', String(open));
  $('menu-toggle').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  $('nav-scrim').hidden = !open;
  syncNavAccessibility();
}

function syncNavAccessibility() {
  const closedOnMobile = window.matchMedia('(max-width: 860px)').matches && !document.body.classList.contains('nav-open');
  $('primary-nav').inert = closedOnMobile;
  if (closedOnMobile) $('primary-nav').setAttribute('aria-hidden', 'true'); else $('primary-nav').removeAttribute('aria-hidden');
}

function showView(name, moveFocus = false) {
  if (!$(`view-${name}`)) name = 'overview';
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('current', view.id === `view-${name}`));
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  history.replaceState({}, '', name === 'overview' ? '/console' : `/console#${name}`);
  setNavOpen(false);
  if (moveFocus) $(`title-${name}`)?.focus();
}

document.querySelectorAll('[data-view]').forEach((button) => { button.onclick = () => showView(button.dataset.view, true); });
document.querySelectorAll('[data-view-jump]').forEach((button) => { button.onclick = () => showView(button.dataset.viewJump, true); });
document.querySelectorAll('[data-refresh]').forEach((button) => { button.onclick = loadAll; });
$('menu-toggle').onclick = () => setNavOpen(!document.body.classList.contains('nav-open'));
$('nav-scrim').onclick = () => setNavOpen(false);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && document.body.classList.contains('nav-open')) setNavOpen(false); });
window.addEventListener('resize', syncNavAccessibility);
$('connection-filter').oninput = renderConnections; $('connection-status').onchange = renderConnections;
$('new-connection').onclick = () => $('connection-dialog').showModal();
$('create-connection').onclick = async (event) => {
  event.preventDefault(); const vendor = $('new-vendor').value.trim().toLowerCase(); const rolePart = vendor.replace(/(^|-)[a-z]/g, (part) => part.replace('-', '').toUpperCase());
  await mutate('/connections', { role: `VendorApi.${rolePart}.Invoke`, secret: $('new-secret').value.trim(), displayName: $('new-display').value.trim(), vendor, baseUrl: $('new-base-url').value.trim(), inject: $('new-inject').value }, 'Route created. Add the Entra app role before granting callers.');
  $('connection-dialog').close(); $('connection-form').reset();
};
$('principal-form').onsubmit = async (event) => { event.preventDefault(); await mutate('/principals', { id: `${$('principal-kind').value}:${$('principal-object-id').value.trim()}`, displayName: $('principal-name').value.trim() }, 'Principal saved.'); $('principal-form').reset(); };
$('branding-form').onsubmit = async (event) => { event.preventDefault(); await mutate('/config/branding', { productName: $('branding-product').value, shortName: $('branding-short').value, logoUrl: $('branding-logo').value, faviconUrl: $('branding-favicon').value, documentationUrl: $('branding-docs').value, supportUrl: $('branding-support').value, colors: Object.fromEntries(['background', 'surface', 'accent', 'text'].map((name) => [name, $(`color-${name}`).value])) }, 'Branding updated.'); };
document.querySelectorAll('#branding-form input').forEach((input) => { input.addEventListener('input', renderBrandingPreview); });

showView(location.hash.slice(1) || 'overview');
loadAll();
