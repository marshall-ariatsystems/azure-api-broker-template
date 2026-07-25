// server.mjs — local admin UI for the Azure API key broker.
//
// Runs ON THE OPERATOR'S MACHINE with the operator's own Azure identity
// (DefaultAzureCredential -> az login). Nothing is hosted in Azure, no credential is stored by
// this app, and key values are write-only: they go INTO Key Vault and are never read back or
// logged. Binds to 127.0.0.1 only.
//
//   cd admin-ui && npm install && npm start   ->   http://localhost:8788
//
// Configuration — a broker.config.json next to this file (or in the working directory) and/or
// environment variables. Env wins over file. See broker.config.example.json. Required keys:
//   sub (BROKER_SUB)        Azure subscription id hosting the broker
//   rg (BROKER_RG)          resource group of the function app
//   app (BROKER_APP)        function app name
//   vault (BROKER_VAULT)    Key Vault name
//   brokerUrl (BROKER_URL)  https://<app>.azurewebsites.net/api/broker
//   appObjectId (BROKER_APPOBJ)  Entra APPLICATION OBJECT id of the broker API app registration
// Optional: port (PORT, default 8788), brandName (BRAND_NAME, shown in the console header).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { WebSiteManagementClient } from '@azure/arm-appservice';

// Search order for sidecar files (broker.config.json, index.html): the script's own directory,
// the directory of the running executable (when packaged as a single binary), then the cwd.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const searchDirs = [...new Set([scriptDir, path.dirname(process.execPath), process.cwd()])];

function findSidecar(name) {
  for (const d of searchDirs) {
    const p = path.join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function loadConfig() {
  let file = {};
  const cfgPath = findSidecar('broker.config.json');
  if (cfgPath) {
    try { file = JSON.parse(readFileSync(cfgPath, 'utf8')); }
    catch (e) { console.error(`broker.config.json at ${cfgPath} is not valid JSON: ${e.message}`); process.exit(1); }
  }
  const cfg = {
    sub: process.env.BROKER_SUB || file.sub,
    rg: process.env.BROKER_RG || file.rg,
    app: process.env.BROKER_APP || file.app,
    vault: process.env.BROKER_VAULT || file.vault,
    brokerUrl: (process.env.BROKER_URL || file.brokerUrl || '').replace(/\/+$/, ''),
    appObjectId: process.env.BROKER_APPOBJ || file.appObjectId,
    port: Number(process.env.PORT || file.port || 8788),
    brandName: process.env.BRAND_NAME || file.brandName || 'API Key Broker',
  };
  const missing = ['sub', 'rg', 'app', 'vault', 'brokerUrl', 'appObjectId'].filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(
      `Missing configuration: ${missing.join(', ')}\n` +
      `Provide a broker.config.json (searched: ${searchDirs.join(', ')})\n` +
      `or env vars BROKER_SUB / BROKER_RG / BROKER_APP / BROKER_VAULT / BROKER_URL / BROKER_APPOBJ.\n` +
      `See broker.config.example.json.`);
    process.exit(1);
  }
  return cfg;
}

const CFG = loadConfig();

const credential = new DefaultAzureCredential();
const secrets = new SecretClient(`https://${CFG.vault}.vault.azure.net`, credential);
const arm = new WebSiteManagementClient(credential, CFG.sub);

// ---------- helpers ----------

async function graphGet(url) {
  const tok = await credential.getToken('https://graph.microsoft.com/.default');
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok.token}` } });
  if (!r.ok) throw new Error(`Graph ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function readAppSettings() {
  const s = await arm.webApps.listApplicationSettings(CFG.rg, CFG.app);
  return s.properties || {};
}

async function readRoleMap() {
  const props = await readAppSettings();
  try { return JSON.parse(props.ROLE_SECRET_MAP || '{}'); } catch { return {}; }
}

async function writeRoleMap(map) {
  const props = await readAppSettings();
  props.ROLE_SECRET_MAP = JSON.stringify(map);
  await arm.webApps.updateApplicationSettings(CFG.rg, CFG.app, { properties: props });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function body(req) {
  let data = '';
  for await (const c of req) data += c;
  return data ? JSON.parse(data) : {};
}

// ---------- API ----------

async function apiState() {
  const [health, appSettings, appRoles, secretList] = await Promise.all([
    // Health: an unauthenticated GET must return 401 (Easy Auth gate up and enforcing).
    fetch(`${CFG.brokerUrl}/get`).then((r) => ({ status: r.status, healthy: r.status === 401 }))
      .catch((e) => ({ status: 0, healthy: false, error: e.message })),
    readAppSettings(),
    graphGet(`https://graph.microsoft.com/v1.0/applications/${CFG.appObjectId}?$select=appRoles,appId,displayName`)
      .then((a) => ({ appId: a.appId, displayName: a.displayName, roles: (a.appRoles || []).filter((r) => r.isEnabled) }))
      .catch((e) => ({ error: e.message, roles: [] })),
    (async () => {
      const out = [];
      for await (const p of secrets.listPropertiesOfSecrets()) {
        out.push({ name: p.name, updated: p.updatedOn, enabled: p.enabled });
      }
      return out;
    })().catch((e) => [{ name: `(error: ${e.message})`, updated: null, enabled: false }]),
  ]);
  let roleMap = {};
  try { roleMap = JSON.parse(appSettings.ROLE_SECRET_MAP || '{}'); } catch { /* leave empty */ }
  const defaults = {
    vendorBaseUrl: appSettings.VENDOR_BASE_URL || '',
    injectMode: appSettings.INJECT_MODE || 'header',
  };
  return { config: CFG, brandName: CFG.brandName, health, roleMap, defaults, app: appRoles, secrets: secretList };
}

// Credential-free vendor reachability probe. The URL is resolved SERVER-SIDE from the role's
// mapping (never taken from the browser); no credentials of any kind are sent.
async function apiProbe(b) {
  const role = String(b.role || '').trim();
  const map = await readRoleMap();
  const entry = map[role];
  if (!entry) throw new Error(`role ${role || '(empty)'} is not mapped`);
  const settings = await readAppSettings();
  const url = (typeof entry === 'object' && entry.baseUrl) || settings.VENDOR_BASE_URL;
  if (!url) throw new Error('no vendor base URL configured for this role');
  const started = Date.now();
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return { ok: true, url, status: r.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, url, error: e.message, ms: Date.now() - started };
  }
}

async function apiSaveSecret(b) {
  const name = String(b.name || '').trim();
  if (!/^[0-9a-zA-Z-]{1,127}$/.test(name)) throw new Error('secret name must be 1-127 chars of letters, digits, dashes');
  let value;
  if (b.kind === 'pair') {
    const idField = String(b.idField || 'keyId').trim();
    const secretField = String(b.secretField || 'secret').trim();
    if (!b.id || !b.secretVal) throw new Error('both id and secret are required for a pair');
    value = JSON.stringify({ [idField]: b.id, [secretField]: b.secretVal });
  } else {
    if (!b.value) throw new Error('key value is required');
    value = String(b.value);
  }
  await secrets.setSecret(name, value);
  return { ok: true, name }; // value intentionally not echoed
}

async function apiSaveMapping(b) {
  const role = String(b.role || '').trim();
  if (!role) throw new Error('role is required');
  const map = await readRoleMap();
  if (b.remove) {
    delete map[role];
  } else {
    const secret = String(b.secret || '').trim();
    if (!secret) throw new Error('secret name is required');
    const entry = { secret };
    for (const k of ['baseUrl', 'inject', 'tokenUrl', 'scope', 'idField', 'secretField']) {
      if (b[k]) entry[k] = String(b[k]).trim();
    }
    // Plain string form when only a secret is given (keeps the setting easy to read).
    map[role] = Object.keys(entry).length === 1 ? secret : entry;
  }
  await writeRoleMap(map);
  return { ok: true, role, map };
}

async function apiRestart() {
  await arm.webApps.restart(CFG.rg, CFG.app);
  return { ok: true };
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const indexPath = findSidecar('index.html');
      if (!indexPath) return json(res, 500, { error: `index.html not found (searched: ${searchDirs.join(', ')})` });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(indexPath));
    } else if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, await apiState());
    } else if (req.method === 'POST' && url.pathname === '/api/secret') {
      json(res, 200, await apiSaveSecret(await body(req)));
    } else if (req.method === 'POST' && url.pathname === '/api/mapping') {
      json(res, 200, await apiSaveMapping(await body(req)));
    } else if (req.method === 'POST' && url.pathname === '/api/restart') {
      json(res, 200, await apiRestart());
    } else if (req.method === 'POST' && url.pathname === '/api/probe') {
      json(res, 200, await apiProbe(await body(req)));
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log(`broker admin UI -> http://localhost:${CFG.port}  (vault=${CFG.vault} app=${CFG.app})`);
});
