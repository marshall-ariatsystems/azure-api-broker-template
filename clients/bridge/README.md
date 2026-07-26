# broker-bridge: Azure reference agent for zero-credential vendor access

Make an app call a vendor API through the broker with a **one-line config change** and **no vendor key
on the box**. The key lives in the broker's Key Vault, and **Entra app-role assignments in one
tenant** decide who may use it, so you stop juggling each vendor's own key management.

```
your app ──http──▶ broker-bridge (localhost) ──https + Entra token──▶ broker ──injects key──▶ vendor
                     (DefaultAzureCredential:                          (Key Vault, server-side)
                      az login / SP / managed identity)
```

The bridge authenticates as the caller's Entra identity, attaches the token, and forwards to the
broker's vendor-named route. It never sees or stores a vendor credential.

> For **zero-touch** integration, where you own the app repo and the developer does nothing, see
> [`BAKE-IN.md`](./BAKE-IN.md). This file covers running it standalone.

## 1. First run — create keyless configuration

```bash
cd clients/bridge
az login
npm run init -- --preset openai
```

This creates a git-ignored `broker.env` containing only the broker URL, Entra scope, vendor slug,
and routing mode. It never asks for or writes a vendor API key. If no `.env` exists, it creates `.env` as a
relative link to `broker.env`; an existing `.env` is left untouched. Use
`npm run init -- --preset openai --append-dotenv` only when you explicitly want to append a managed
Broker Bridge block to an existing `.env`.

Replace the placeholders in `broker.env` with values from the instance outputs.

## Deployment paths

**Local developer.** Run `az login`; `DefaultAzureCredential` uses that signed-in developer identity.

**Container sidecar / workload.** Use managed identity where available. It is the production default;
see [`BAKE-IN.md`](./BAKE-IN.md) for the zero-touch integration path.

## 2. Run the bridge

```bash
cd clients/bridge
npm install               # first time only; init itself works before this
npm run serve             # loads ./broker.env -> http://127.0.0.1:8079
curl -s http://127.0.0.1:8079/_bridge/health
```

`BROKER_BASE` and `BROKER_SCOPE` in the shell override `broker.env`, which is useful for CI and
managed-identity deployments. The bridge refuses to bind outside loopback, even if `BRIDGE_HOST` is
set in the file or environment.

To launch an existing app and stop the bridge automatically when it exits, use `run` instead:

```bash
npm run run -- --preset openai -- node app.mjs
```

`run` waits for `/_bridge/health`, supplies the preset's local URL and `broker-managed` placeholder
to the child, returns the child's exit code, then stops the loopback listener. Use `--set` for a
non-standard environment-variable name; values are limited to the local bridge URL or the harmless
placeholder:

```bash
npm run run -- --preset openai \
  --set MY_VENDOR_URL=http://127.0.0.1:8079/openai/v1 \
  --set MY_VENDOR_KEY=broker-managed \
  -- node app.mjs
```

## 3. Change an app (the whole change)

Repoint the base URL the app already reads, and delete the key:

```diff
- VENDOR_API_KEY=…
- VENDOR_BASE_URL=https://api.vendor.com/v1
+ VENDOR_BASE_URL=http://127.0.0.1:8079/<slug>/v1
```

The first path segment is the **vendor slug**. In the default `BROKER_ROUTING_MODE=strict`, it must
match `BROKER_VENDOR` and is consumed before forwarding, so a one-role broker receives only the
vendor-native path. `named` mode preserves the slug for a broker that has explicitly enabled
multi-role routing. `curl -s http://127.0.0.1:8079/_bridge/vendors` lists optional public route
metadata; the broker remains authoritative.

## 4. Prerequisites (server side, once per vendor and per identity)

1. Onboard the vendor on the broker: KV secret, app role, `ROLE_SECRET_MAP` entry.
   [`cicd/onboard-vendor.sh`](../../cicd/onboard-vendor.sh) does all three (`cicd/onboarding-runbook.md`).
2. Assign the identity the role on the broker Enterprise Application
   (`appRoleAssignmentRequired=true`). No assignment ⇒ no `roles` claim ⇒ broker denies.
3. Calling several vendors from one identity needs the instance app setting
   `MULTI_ROLE_VENDOR_ROUTING=true` **and** `BROKER_ROUTING_MODE=named` in the local profile. The
   default is strict, which preserves spec §3c: exactly one vendor role, else 403.

```bash
az functionapp config appsettings set -g <broker-rg> -n <func-app> \
  --settings MULTI_ROLE_VENDOR_ROUTING=true
```

## Governance: key → identity 1-to-1

An identity may hold many vendor keys; each vendor key should map to one identity. Entra doesn't
enforce this, so audit that no vendor role has more than one assignee (see
`cicd/onboarding-runbook.md`).

## Auth model

`DefaultAzureCredential` resolves env SP → managed identity → `az login`. In practice that means
`az login` on a dev laptop, the **managed identity** for anything running in Azure, and an SP or
federated credential for headless and CI hosts. Any **Conditional Access** on the Enterprise App
applies to the bridge's token acquisition too, which catches people out the first time.

## Networking

If the broker is locked to a private ingress (VPN, or your private ingress CIDR, with public access
disabled), the host running the bridge has to sit on that private path. Otherwise the bridge starts
fine and every forward times out.
