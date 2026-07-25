# Grant / revoke runbook (az CLI only)

> Spec owner: §4.3 (app roles, assignment-required, direct SP assignment), §6.1 (least-privilege RBAC), §8 (rotation). All steps use the `az` CLI. No Azure MCP server.

## 0. Placeholders (substitute at deploy time)

```bash
TENANT_ID='11111111-1111-1111-1111-111111111111'        # PLACEHOLDER
BROKER_CLIENT_ID='00000000-0000-0000-0000-000000000000'   # PLACEHOLDER (from identity/outputs.json)
APP_ID_URI="api://$BROKER_CLIENT_ID"
KV_NAME='apibkr-optd-kv'                                 # from iac/outputs.json
FUNC_PRINCIPAL_ID='PLACEHOLDER_SYSTEM_ASSIGNED_MANAGED_IDENTITY_PRINCIP_ID'  # from iac/outputs.json
```

## 1. Apply the app-role manifest (spec §4.3)

`identity/app-roles.json` holds the role-to-secret mapping and is the source of truth. This command pushes it into Entra:

```bash
az ad app update --id "$BROKER_CLIENT_ID" --set appRoles='[
  {"allowedMemberTypes":["Application","User"],"description":"Team A vendor key (secret vendor-api-key-team-a).","displayName":"Vendor API Key A - Invoke","id":"'$(uuidgen)'","isEnabled":true,"value":"VendorApi.KeyA.Invoke"},
  {"allowedMemberTypes":["Application","User"],"description":"Team B vendor key (secret vendor-api-key-team-b).","displayName":"Vendor API Key B - Invoke","id":"'$(uuidgen)'","isEnabled":true,"value":"VendorApi.KeyB.Invoke"},
  {"allowedMemberTypes":["Application","User"],"description":"Production CI vendor key (secret vendor-api-key-ci).","displayName":"Vendor API Key C - Invoke","id":"'$(uuidgen)'","isEnabled":true,"value":"VendorApi.KeyC.Invoke"},
  {"allowedMemberTypes":["User"],"description":"Admin canary/test key (secret vendor-api-key-canary).","displayName":"Vendor API Admin Test - Invoke","id":"'$(uuidgen)'","isEnabled":true,"value":"VendorApi.Admin.Test"}
]'
```

## 2. Enable "Assignment required" on the Broker enterprise application (spec §4.3)

```bash
az ad sp update --id "$BROKER_CLIENT_ID" --set appRoleAssignmentRequired=true
```

## 3. Grant a HUMAN user a key role (via group, then app-role)

```bash
GROUP_ID=$(az ad group create --display-name "Broker KeyA Users" --mail-nickname "broker-keya-users" --query id -o tsv)
az ad group member add --group "$GROUP_ID" --member-id "<user-object-id>"

# Assign the app role to the group (humans may use group-based assignment).
ROLE_A_ID=$(az ad app show --id "$BROKER_CLIENT_ID" --query 'appRoles[?value==`VendorApi.KeyA.Invoke`].id' -o tsv)
az ad app role assignment add --id "$BROKER_CLIENT_ID" --role "$ROLE_A_ID" --assignee-object-id "$GROUP_ID" --assignee-principal-type Group
```

## 4. Grant a CI WORKLOAD service principal a DIRECT per-key app role (spec §4.3, NO group nesting)

> **Critical:** Entra omits the `roles` claim for application tokens when the app role is assigned via a group. CI workload SPs MUST get a DIRECT app-role assignment to the Broker service principal.

```bash
CI_SP_ID='<ci-workload-service-principal-object-id>'  # the SP that GitHub OIDC exchanges into
ROLE_C_ID=$(az ad app show --id "$BROKER_CLIENT_ID" --query 'appRoles[?value==`VendorApi.KeyC.Invoke`].id' -o tsv)
az ad app role assignment add \
  --id "$BROKER_CLIENT_ID" \
  --role "$ROLE_C_ID" \
  --assignee-object-id "$CI_SP_ID" \
  --assignee-principal-type ServicePrincipal
```

Verify the CI SP now carries the role in its app-only token (see `test/token-claims-assert.sh`):

```bash
az ad sp show --id "$CI_SP_ID" --query 'appRoleAssignments'
```

## 5. Grant the Function managed identity `Key Vault Secrets User` scoped to ONLY the vendor-key secrets (spec §6.1)

This is the least-privilege control, and `iac/keyvault.bicep` already applies it with RBAC scoped to each secret rather than the vault. The equivalent via `az`:

```bash
for SECRET in vendor-api-key-team-a vendor-api-key-team-b vendor-api-key-ci vendor-api-key-canary; do
  az role assignment create \
    --role "Key Vault Secrets User" \
    --assignee-object-id "$FUNC_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --scope "$(az keyvault secret show --vault-name "$KV_NAME" --name "$SECRET" --query id -o tsv)"
done
```

> Scope is the **secret**, not the vault. A compromised broker cannot read unrelated secrets.

## 6. Rotate a vendor key (spec §8)

```bash
az keyvault secret set --vault-name "$KV_NAME" --name "vendor-api-key-team-a" --value '<NEW-REAL-VENDOR-KEY-OUT-OF-BAND>'
# The Function's 5-min cache TTL picks up the new value on the next refresh.
# For IMMEDIATE pickup, trigger the Event Grid cache-bust (see test/rotation-runbook.md), or:
# redeploy the Function (restart clears the in-memory cache).
az functionapp restart --name "apibkr-optd-func" --resource-group "<rg>"
```

> Zero-downtime rotation requires the vendor to support overlapping active keys (spec §8). If the vendor allows only one live key, document a brief planned cutover window.

## 7. Revoke access (spec §4.3, admin_model)

```bash
# Remove a human from the group:
az ad group member remove --group "$GROUP_ID" --member-id "<user-object-id>"

# Remove a CI SP's direct app-role assignment:
az ad app role assignment remove --id "$BROKER_CLIENT_ID" --role "$ROLE_C_ID" --assignee-object-id "$CI_SP_ID" --assignee-principal-type ServicePrincipal

# If a key is suspected exposed: rotate it (§6) AND revoke the role that selected it.
```

## 8. Break-glass (spec §8)

If the broker is down or its managed identity loses Key Vault access:
1. Verify the MI's `Key Vault Secrets User` assignment on the specific secrets (§5).
2. Confirm the Function's VNet integration and access restrictions are intact.
3. Redeploy the Function from source with the pinned configuration.
4. As a last resort, the admin (not developers) issues vendor calls directly from a controlled admin workstation while the broker is restored.
