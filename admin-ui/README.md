# API Key Broker Console

A **local** web front end for the Azure API key broker. No hosting, no stored credentials: it
runs on your machine, authenticates as **you** (`az login` → DefaultAzureCredential), and binds
to `127.0.0.1` only. Key values are **write-only**. They go into Key Vault and are never read
back, displayed, or logged.

## Run

```
cd admin-ui
cp broker.config.example.json broker.config.json   # then fill in your broker's values
npm install        # first time only
npm start          # -> http://localhost:8788
```

## What you can do by clicking

| Action | What happens |
|---|---|
| **Add/update a key** | Pick/name a Key Vault secret, paste a single key **or** an id+secret pair (stored as one JSON secret so both halves rotate atomically). Saved straight to the configured vault. Broker picks it up ≤5 min, or hit Restart. |
| **Edit a role mapping** | Per app role: secret name, inject mode (`header`/`bearer`/`basic`/`pair`/`oauth2cc`), vendor base URL, OAuth token URL/scope, pair field names. Writes the `ROLE_SECRET_MAP` app setting correctly (no shell quote-mangling). |
| **Unmap a role** | Removes a role's vendor mapping (confirm-gated; callers 403 until re-mapped). |
| **Probe vendor** | Credential-free reachability check of a role's vendor base URL (status + latency). |
| **Restart broker** | Recycles the function app so mapping changes apply (confirm-gated). |
| **Health tile** | Green = unauthenticated request → 401 (Easy Auth enforcing). Click to re-check. |
| **Copy tiles / endpoint chip** | Click any overview tile or the header chip to copy names/IDs. |

## Permissions you need

Your Azure identity must hold: **Key Vault Secrets Officer** on the vault (write secrets),
**Website Contributor**-level rights on the function app (app settings + restart), and Graph
read on the app registration (any member can read app roles).

## Configuration

All broker targeting lives in `broker.config.json` next to `server.mjs` (or in the working
directory). See `broker.config.example.json` for every key. Env vars override the file:
`BROKER_SUB`, `BROKER_RG`, `BROKER_APP`, `BROKER_VAULT`, `BROKER_URL`, `BROKER_APPOBJ`,
`PORT`, `BRAND_NAME`. The server refuses to start until all required values are present.
`brandName` is shown in the console header; instance repos set this to their org name.

## What it deliberately does NOT do

- Show or export key values (write-only by design)
- Create/delete Entra app roles or role assignments. Those are tenant-admin actions, so use the
  portal: Enterprise applications → your broker API app → Users and groups
- Run hosted anywhere. It is not an Azure site; do not deploy it.
