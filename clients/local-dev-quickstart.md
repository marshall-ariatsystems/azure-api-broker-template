# Local dev quickstart (spec §4.4, §15 step 4)

> You never see, store, or transmit a vendor key. You authenticate with YOUR Entra identity and call the broker; the broker injects the vendor key server-side.

## 1. Prerequisites

- `az` CLI, logged in: `az login` (device code or interactive).
- Membership in a group assigned one `VendorApi.Key*.Invoke` app role (the admin grants this; see `identity/grant-revoke-runbook.md`).
- Network reachability to `broker.contoso.com` over the existing private on-prem/VPN ingress path. You must be on-prem or VPN-connected.

## 2. Substitute placeholders (admin provides the real values)

```bash
TENANT_ID='11111111-1111-1111-1111-111111111111'           # PLACEHOLDER → real tenant
APP_ID_URI='api://00000000-0000-0000-0000-000000000000'      # PLACEHOLDER → real broker App ID URI
BROKER_HOST='broker.contoso.com'
```

## 3. Acquire a v2 broker token (`--scope`, NOT `--resource`)

> **Critical:** `az account get-access-token --resource <uri>` requests a **v1** token (rejected by Easy Auth). `--scope "<appIdUri>/.default"` requests a **v2** token (spec §4.2). Always use `--scope`.

```bash
TOKEN=$(az account get-access-token --scope "${APP_ID_URI}/.default" --query accessToken -o tsv)
```

## 4. Assert your token claims (spec §12.1: decode aud/iss/roles BEFORE calling the broker)

```bash
bash test/token-claims-assert.sh
```

This asserts `ver=2.0`, `aud == client-id GUID (or api://GUID)`, `iss == v2 endpoint`, and exactly one `VendorApi.Key*` role.

## 5. Call the broker (only `Authorization: Bearer`; NO vendor key anywhere)

```bash
curl -fsS -w '\nHTTP_STATUS:%{http_code}\n' \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://${BROKER_HOST}/v1/health"
```

Or use the helper: `bash clients/call-broker.sh v1/health`.

## 6. What to expect

- **200** with the vendor response. Your role selected the correct key server-side.
- **403** `Caller must have exactly one vendor-key role`. You hold zero or more than one recognized key role; contact the admin to fix your role assignment.
- **401**. Your token is missing, expired, or from the wrong issuer/audience. Re-run step 3.
- **429** `Rate limit exceeded` + `Retry-After`. You exceeded the per-caller or per-key quota (spec §9).

## Microsoft Learn citations

- `az account get-access-token` (scope=v2): https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token
- Access token claims reference: https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
- OAuth2 authorization code flow (interactive MSAL): https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
