# RBAC governance: access review cadence + least-privilege checklist (spec §11)

> spec §6.1: the Function's system-assigned managed identity holds `Key Vault Secrets User` scoped to **only the vendor-key secrets**, not the whole vault. spec §4.3: the admin solely controls key creation and access via Entra group/app-role assignment.

## 1. Recurring access review (quarterly)

| What to review | Expected state | `az` check |
|---|---|---|
| Who can edit the broker Function / IaC | Named admins only | `az role assignment list --scope <func-app-id> --role "Contributor"` |
| Who holds each `VendorApi.Key*` app role | Matches the approved roster | `az ad app role assignment list --id "$BROKER_CLIENT_ID"` |
| CI workload SPs have DIRECT app-role assignments (no group nesting) | No group→role assignments for app tokens | `az ad app role assignment list --id "$BROKER_CLIENT_ID" --query '[?principalType==`ServicePrincipal`]'` |
| Function MI scope is vendor-key-secrets-only | `Key Vault Secrets User` on each secret, not the vault | `az role assignment list --scope <secret-id> --assignee "$FUNC_PRINCIPAL_ID"` |
| Key Vault RBAC mode + purge protection | `enableRbacAuthorization=true`, `enablePurgeProtection=true` | `az keyvault show --name "$KV_NAME"` |
| No human has routine read on vendor-key secret values | Empty list | `az role assignment list --scope <vault-id> --role "Key Vault Secrets Reader"` |

## 2. Least-privilege checklist (gate-failing if any is false)

- [ ] The Function MI's `Key Vault Secrets User` role is scoped to **each vendor-key secret**, not the vault.
- [ ] The Key Vault has `publicNetworkAccess: Disabled` and `networkAcls.bypass: AzureServices`.
- [ ] The Function has `publicNetworkAccess: Disabled` with access restrictions scoped to your on-prem/VPN ingress CIDR only.
- [ ] Easy Auth requires authentication (unauthenticated → 401); allowed audiences = client-id GUID + `api://<client-id>`.
- [ ] "Assignment required" is enabled on the Broker enterprise application.
- [ ] CI workload SPs use OIDC workload identity federation (no client secret).
- [ ] No GitHub repo/Actions secret holds a vendor key or Azure client secret.
- [ ] Your existing network (VNet peering, gateways, routes, appliances, tunnels) is untouched (read-only reference only).

## 3. Offboarding

When a caller leaves or changes role:
1. Remove them from the Entra group, or remove the direct app-role assignment (`identity/grant-revoke-runbook.md` §7).
2. If you suspect the key they could select is exposed, rotate it (`§6`).
3. Check App Insights for odd usage under their `oid` in the 30 days before offboarding.
