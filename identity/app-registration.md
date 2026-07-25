# Broker app registration (spec §4, §4.3)

> All steps use the `az` CLI (no Azure MCP server). The client-id is a **placeholder** substituted at deploy time; record it as such in `identity/outputs.json`.

## 1. Create the Broker API app registration

```bash
# Placeholder tenant; substitute the real tenant at deploy time.
TENANT_ID='11111111-1111-1111-1111-111111111111'  # PLACEHOLDER

az ad app create \
  --display-name "Vendor API Key Broker" \
  --identifier-uris "api://00000000-0000-0000-0000-000000000000"  # PLACEHOLDER client-id; update after creation
```

After creation, capture the real `appId` (client-id) and update the identifier URI:

```bash
BROKER_CLIENT_ID=$(az ad app list --display-name "Vendor API Key Broker" --query '[0].appId' -o tsv)
az ad app update --id "$BROKER_CLIENT_ID" --identifier-uris "api://$BROKER_CLIENT_ID"
```

## 2. Set `requestedAccessTokenVersion: 2` (spec §4.2, the council's v1/v2 correction)

```bash
# A v1/v2 mismatch is the MOST COMMON cause of token rejection. The manifest MUST set v2.
az ad app update --id "$BROKER_CLIENT_ID" --set requestedAccessTokenVersion=2
```

Verify:

```bash
az ad app show --id "$BROKER_CLIENT_ID" --query 'requestedAccessTokenVersion'
# expected: 2
```

## 3. Expose a delegated scope `VendorApi.Invoke` (spec §4.3, interactive local dev)

```bash
SCOPE_ID=$(az ad app show --id "$BROKER_CLIENT_ID" --query 'oauth2Permissions[0].id' -o tsv)
az ad app update --id "$BROKER_CLIENT_ID" \
  --set oauth2Permissions='[{"adminConsentDescription":"Allows the caller to invoke the vendor API through the broker; key selection is enforced server-side by the caller'\''s app role.","adminConsentDisplayName":"Invoke the vendor API through the broker","id":"'"$SCOPE_ID"'","isEnabled":true,"type":"User","userConsentDescription":"Invoke the vendor API through the broker (no vendor key exposure).","userConsentDisplayName":"Invoke vendor API","value":"VendorApi.Invoke"}]'
```

## 4. Define app roles (spec §4.3, including the CI `Application` fix)

> **Warning:** app roles used by CI MUST include `Application` in `allowedMemberTypes`. If a role only allows `User`, a CI **app-only** token carries **no `roles` claim** and every CI call returns 403. This is the most likely day-one CI failure, and the 403 gives you nothing to go on.

The full role set (source of truth: `identity/app-roles.json`) maps each role to one Key Vault secret name:

| Role value | allowedMemberTypes | Key Vault secret |
|---|---|---|
| `VendorApi.KeyA.Invoke` | Application, User | `vendor-api-key-team-a` |
| `VendorApi.KeyB.Invoke` | Application, User | `vendor-api-key-team-b` |
| `VendorApi.KeyC.Invoke` | Application, User | `vendor-api-key-ci` |
| `VendorApi.Admin.Test` | User | `vendor-api-key-canary` |

Apply via the manifest (`az ad app update --set appRoles=@identity/app-roles-manifest.json`); see `grant-revoke-runbook.md` for the full `az` sequence including the app-role manifest blob.

## 5. Enable "Assignment required" (spec §4.3, role-less tokens fail at issuance)

```bash
az ad sp update --id "$BROKER_CLIENT_ID" --set appRoleAssignmentRequired=true
```

Now a role-less app-only token fails at **issuance** instead of only at the broker. Defense in depth, and it fails earlier, where the error is easier to read.

## 6. Grant CI workload SPs a DIRECT app-role assignment (spec §4.3, no group nesting)

> **Critical:** do NOT assign the app role to a workload SP via a group→role assignment. Entra omits the `roles` claim for application tokens in the group-nesting case, so the assignment looks correct in the portal and the token still comes back empty. This one bites people. Grant the workload service principal a **direct** app-role assignment to the Broker service principal, and complete admin consent.

See `grant-revoke-runbook.md` for the exact `az ad sp app-role assignment` commands.

## 7. Configure Easy Auth on the Function (spec §4.1)

Apply `iac/auth.bicep` (or the `az` equivalent) after the app reg exists so the real client-id can be substituted. Allowed audiences = `brokerClientId` GUID AND `api://<brokerClientId>`. Require authentication (unauthenticated → 401).

## Microsoft Learn citations

- App roles (`allowedMemberTypes=Application`): https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps
- App manifest `requestedAccessTokenVersion`: https://learn.microsoft.com/en-us/entra/identity-platform/reference-app-manifest
- Access token claims reference: https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
- Restrict an app to a set of users (assignment required): https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users
- Workload identity federation with GitHub: https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-github
