# Vendor onboarding runbook (generic, az CLI only)

> Add a vendor to a broker instance in one command. Spec owners: §4.3 (app roles), §5.1 (role→secret
> map), §6.1 (least-privilege KV RBAC). Driver: [`cicd/onboard-vendor.sh`](./onboard-vendor.sh).

`onboard-vendor.sh` does all five steps idempotently: KV secret → MI read-grant (scoped to the one
secret) → Entra app role → `ROLE_SECRET_MAP` merge → optional role assignment. Run it once per vendor
when standing a client instance up from this template.

## 1. Fill the broker-instance values (once per instance)

From `iac/outputs.json` and `identity/outputs.json` after the instance is deployed:

```bash
export SUBSCRIPTION=<sub-guid>
export RESOURCE_GROUP=<broker-rg>
export FUNCTION_APP=<func-app-name>
export KV_NAME=<key-vault-name>
export BROKER_CLIENT_ID=<broker-API-app-registration-client-id>
export FUNC_PRINCIPAL_ID=<function-system-assigned-MI-principalId>
```

## 2. Onboard a vendor

### `oauth2cc`: fully keyless client-credentials (e.g. HCSS)

The broker holds `client_id`/`client_secret`, mints the Bearer, **caches it (TTL from the token's own
`expires_in`)**, and injects it. The consuming app implements **no OAuth** at all; it just calls
`broker/<slug>/…`. This is the maximally-keyless flow.

```bash
export VENDOR_NAME=HCSS                                  # PascalCase -> role VendorApi.HCSS.Invoke, slug 'hcss'
export INJECT=oauth2cc
export BASE_URL=https://<hcss-api-base>
export TOKEN_URL=https://<hcss-token-endpoint>           # required for oauth2cc
export SCOPE=<scope-or-unset>                            # optional
export VENDOR_CLIENT_ID=…   VENDOR_CLIENT_SECRET=…       # from the ENV, never echoed
#   IDFIELD / SECRETFIELD only if the vendor's token endpoint wants field names
#   other than client_id / client_secret.

./cicd/onboard-vendor.sh --dry-run    # review every az command
./cicd/onboard-vendor.sh              # execute
```

> Confirm the vendor's token endpoint returns **`expires_in`** so the broker caches at the real TTL
> (it falls back to 300s otherwise). Refresh is expiry-based; early-invalidation retry is FR-3.

### `header` / `bearer`: a single static key

```bash
export VENDOR_NAME=Acme INJECT=bearer BASE_URL=https://api.acme.example.com/v1
export VENDOR_KEY=…                                      # the single key, from the ENV
./cicd/onboard-vendor.sh
```

`header` injects `VENDOR_KEY_HEADER_NAME` (default `x-api-key`); `bearer` injects `Authorization:
Bearer`. (A per-vendor custom header name is FR-2.)

### `pair` / `basic`: two-part key

Same env as `oauth2cc` minus `TOKEN_URL`/`SCOPE`: `pair` injects the id/secret as two headers;
`basic` injects HTTP Basic.

## 3. Assign the role to each consumer identity

Either set `ASSIGNEE_OBJECT_ID` (+ `ASSIGNEE_TYPE`) before running, or follow
`identity/grant-revoke-runbook.md` §3 (human via group) / §4 (workload SP, direct).

**Governance: keep key→identity 1:1.** One identity may hold many vendor roles, but each vendor role
should be assigned to exactly one principal. Entra won't enforce that for you, so audit it yourself:

```bash
BROKER_SP=$(az ad sp show --id "$BROKER_CLIENT_ID" --query id -o tsv)
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$BROKER_SP/appRoleAssignedTo?\$select=appRoleId,principalDisplayName" \
  --query value -o table
```

## Notes

- Re-running is safe. An app role that already exists is skipped, and `ROLE_SECRET_MAP` gets merged
  into, never clobbered.
- Secrets are read from the environment only and never printed. `--dry-run` redacts the KV value.
- One app calling several vendors needs the instance app setting `MULTI_ROLE_VENDOR_ROUTING=true`.
  Leave it off and a caller must hold exactly one vendor role (spec §3c).
- On the app side it's the drop-in bridge (`clients/bridge/`): point the app's base URL at
  `http://127.0.0.1:8079/<slug>/` and delete its key.
