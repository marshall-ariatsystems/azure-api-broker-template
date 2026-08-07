#!/usr/bin/env bash
# onboard-vendor.sh — generic, idempotent onboarding of ONE vendor into a broker instance.
# az CLI only (no Azure MCP). Spec owners: §4.3 (app roles), §5.1 (role->secret map), §6.1 (KV RBAC).
#
# It performs, in order:
#   1. write the vendor secret to Key Vault      (single key, or a client_id/client_secret pair)
#   2. grant the Function managed identity read on ONLY that secret   (least privilege, §6.1)
#   3. add the Entra app role                     (idempotent; skipped if the role already exists)
#   4. merge the ROLE_SECRET_MAP app setting       (no redeploy; merges, never clobbers)
#   5. optionally assign the role to a consumer identity (if ASSIGNEE_OBJECT_ID is set)
#
# Inject modes (set INJECT):
#   header | bearer   secret is a single opaque key      -> env: VENDOR_KEY
#   pair   | basic    secret is {client_id, client_secret}-> env: VENDOR_CLIENT_ID + VENDOR_CLIENT_SECRET
#   oauth2cc          client-credentials: the broker mints AND caches the Bearer itself, so the
#                     consuming app is fully keyless and implements no OAuth. Same pair as above,
#                     plus TOKEN_URL (required) and SCOPE (optional). This is the HCSS-style flow.
#   entra             secretless workload identity: the Function mints the vendor token itself.
#
# Fill the env vars below, then:   ./onboard-vendor.sh --dry-run    (prints every az command)
#                          then:   ./onboard-vendor.sh              (executes)
# Secret material is read from the ENVIRONMENT only (never CLI args) and never echoed.
set -euo pipefail

# ---- required: broker instance (from generated local deployment state) ---------------------------
: "${SUBSCRIPTION:?subscription id}"
: "${RESOURCE_GROUP:?broker resource group}"
: "${FUNCTION_APP:?function app name}"
: "${KV_NAME:?key vault name}"
: "${BROKER_CLIENT_ID:?broker API app registration client-id}"
: "${FUNC_PRINCIPAL_ID:?function system-assigned managed identity principalId}"

# ---- required: the vendor ------------------------------------------------------------------------
: "${VENDOR_NAME:?e.g. HCSS}"                    # PascalCase; drives role + slug + default secret name
: "${INJECT:?header|bearer|pair|basic|oauth2cc|entra}"
: "${BASE_URL:?vendor API base URL, e.g. https://api.vendor.com/v1}"

# ---- derived / optional --------------------------------------------------------------------------
ROLE_VALUE="${ROLE_VALUE:-VendorApi.${VENDOR_NAME}.Invoke}"
SECRET_NAME="${SECRET_NAME:-$VENDOR_NAME}"
SLUG="$(printf '%s' "$VENDOR_NAME" | tr '[:upper:]' '[:lower:]')"   # broker/<slug>/... route segment
TOKEN_URL="${TOKEN_URL:-}"        # oauth2cc: required
SCOPE="${SCOPE:-}"                # oauth2cc: optional
IDFIELD="${IDFIELD:-}"            # override pair field names if the vendor differs from client_id/secret
SECRETFIELD="${SECRETFIELD:-}"
ASSIGNEE_OBJECT_ID="${ASSIGNEE_OBJECT_ID:-}"           # optional: assign the role now
ASSIGNEE_TYPE="${ASSIGNEE_TYPE:-ServicePrincipal}"     # ServicePrincipal | Group | User

DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
say(){ printf '\n=== %s ===\n' "$*"; }
run(){ if [[ $DRY -eq 1 ]]; then printf '  + %s\n' "$*"; else eval "$*"; fi; }   # NEVER pass secrets here
command -v jq >/dev/null || { echo "jq is required"; exit 3; }
[[ "$INJECT" =~ ^(header|bearer|pair|basic|oauth2cc|entra)$ ]] || { echo "bad INJECT=$INJECT"; exit 2; }
[[ "$INJECT" == "oauth2cc" && -z "$TOKEN_URL" ]] && { echo "oauth2cc requires TOKEN_URL"; exit 2; }
[[ "$INJECT" == "entra" && -z "$SCOPE" ]] && { echo "entra requires SCOPE"; exit 2; }
AZ="az --subscription $SUBSCRIPTION"

# ---- build the secret value (from env; never printed) --------------------------------------------
case "$INJECT" in
  header|bearer)
    : "${VENDOR_KEY:?set VENDOR_KEY for inject=$INJECT}"
    SECRET_VALUE="$VENDOR_KEY" ;;
  pair|basic|oauth2cc)
    : "${VENDOR_CLIENT_ID:?}"; : "${VENDOR_CLIENT_SECRET:?}"
    idf="${IDFIELD:-client_id}"; secf="${SECRETFIELD:-client_secret}"
    SECRET_VALUE="$(jq -nc --arg a "$VENDOR_CLIENT_ID" --arg b "$VENDOR_CLIENT_SECRET" \
                          --arg idf "$idf" --arg secf "$secf" '{($idf):$a,($secf):$b}')" ;;
  entra)
    SECRET_VALUE='' ;;
esac

# ---- 1. Key Vault secret (value redacted; env-sourced) -------------------------------------------
say "1. Key Vault secret '$SECRET_NAME'"
if [[ "$INJECT" == "entra" ]]; then
  echo "  skipped — workload identity token, no vendor secret."
elif [[ $DRY -eq 1 ]]; then
  echo "  + $AZ keyvault secret set --vault-name $KV_NAME --name $SECRET_NAME --value <redacted>"
else
  $AZ keyvault secret set --vault-name "$KV_NAME" --name "$SECRET_NAME" --value "$SECRET_VALUE" >/dev/null
  echo "  set."
fi

# ---- 2. least-privilege read for the Function MI, scoped to THIS secret --------------------------
say "2. grant Function MI 'Key Vault Secrets User' on secret '$SECRET_NAME'"
if [[ "$INJECT" == "entra" ]]; then
  echo "  skipped — no Key Vault secret to read."
elif [[ $DRY -eq 1 ]]; then
  echo "  + SECRET_ID=\$($AZ keyvault secret show --vault-name $KV_NAME --name $SECRET_NAME --query id -o tsv)"
  echo "  + $AZ role assignment create --role 'Key Vault Secrets User' --assignee-object-id $FUNC_PRINCIPAL_ID --assignee-principal-type ServicePrincipal --scope \$SECRET_ID"
else
  SECRET_ID="$($AZ keyvault secret show --vault-name "$KV_NAME" --name "$SECRET_NAME" --query id -o tsv)"
  $AZ role assignment create --role "Key Vault Secrets User" \
     --assignee-object-id "$FUNC_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
     --scope "$SECRET_ID" >/dev/null 2>&1 || echo "  (assignment may already exist)"
  echo "  granted."
fi

# ---- 3. Entra app role (idempotent) --------------------------------------------------------------
say "3. app role '$ROLE_VALUE'"
ROLES="$($AZ ad app show --id "$BROKER_CLIENT_ID" --query appRoles -o json 2>/dev/null || echo '[]')"
if jq -e --arg r "$ROLE_VALUE" 'any(.[]?; .value==$r)' >/dev/null <<<"$ROLES"; then
  echo "  role already present — skipping."
else
  ROLE_DESCRIPTION="Invoke $VENDOR_NAME through the broker."
  [[ "$INJECT" != "entra" ]] && ROLE_DESCRIPTION="Invoke $VENDOR_NAME through the broker (Key Vault secret $SECRET_NAME)."
  NEWROLES="$(jq -c --arg r "$ROLE_VALUE" --arg n "$VENDOR_NAME - Invoke" \
    --arg d "$ROLE_DESCRIPTION" \
    --arg id "$(uuidgen)" \
    '. + [{allowedMemberTypes:["Application","User"],description:$d,displayName:$n,id:$id,isEnabled:true,value:$r}]' \
    <<<"$ROLES")"
  run "$AZ ad app update --id $BROKER_CLIENT_ID --set appRoles='$NEWROLES'"
  echo "  added."
fi

# ---- 4. ROLE_SECRET_MAP entry (merge; no redeploy) -----------------------------------------------
say "4. ROLE_SECRET_MAP entry for '$ROLE_VALUE'"
ENTRY="$(jq -nc --arg secret "$SECRET_NAME" --arg base "$BASE_URL" --arg inject "$INJECT" \
  --arg tokenUrl "$TOKEN_URL" --arg scope "$SCOPE" --arg idf "$IDFIELD" --arg secf "$SECRETFIELD" '
  {baseUrl:$base, inject:$inject}
  + (if $inject!="entra" then {secret:$secret} else {} end)
  + (if $tokenUrl!="" then {tokenUrl:$tokenUrl} else {} end)
  + (if $scope!=""    then {scope:$scope}       else {} end)
  + (if $idf!=""      then {idField:$idf}        else {} end)
  + (if $secf!=""     then {secretField:$secf}   else {} end)')"
echo "  entry: $ENTRY"
CUR="$($AZ functionapp config appsettings list -g "$RESOURCE_GROUP" -n "$FUNCTION_APP" \
        --query "[?name=='ROLE_SECRET_MAP'].value | [0]" -o tsv 2>/dev/null || true)"
[[ -z "$CUR" || "$CUR" == "None" ]] && CUR='{}'
NEW="$(jq -c --arg role "$ROLE_VALUE" --argjson entry "$ENTRY" '. + {($role):$entry}' <<<"$CUR")"
run "$AZ functionapp config appsettings set -g $RESOURCE_GROUP -n $FUNCTION_APP --settings ROLE_SECRET_MAP='$NEW' >/dev/null"

# ---- 5. optional: assign the role to a consumer identity -----------------------------------------
say "5. role assignment"
if [[ -n "$ASSIGNEE_OBJECT_ID" ]]; then
  ROLE_ID="$($AZ ad app show --id "$BROKER_CLIENT_ID" --query "appRoles[?value=='$ROLE_VALUE'].id | [0]" -o tsv 2>/dev/null || true)"
  run "$AZ ad app role assignment add --id $BROKER_CLIENT_ID --role ${ROLE_ID:-<role-id>} --assignee-object-id $ASSIGNEE_OBJECT_ID --assignee-principal-type $ASSIGNEE_TYPE"
  echo "  NOTE: keep key->identity 1:1 — assign each vendor role to exactly ONE principal."
else
  echo "  skipped (set ASSIGNEE_OBJECT_ID to assign). Grant per grant-revoke-runbook.md §3/§4."
fi

say "done — app call: broker/$SLUG/<vendor-path>  (multi-vendor per identity needs MULTI_ROLE_VENDOR_ROUTING=true)"
