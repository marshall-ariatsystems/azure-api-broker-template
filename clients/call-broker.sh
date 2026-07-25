#!/usr/bin/env bash
# clients/call-broker.sh — call the broker with a v2 Entra token (spec §4.4, §12.1).
#
# SMOKE BARS:
#  - uses broker.contoso.com (no public IP)
#  - token acquired with --scope "<appIdUri>/.default" (v2; NOT --resource)
#  - asserts token claims (aud/iss/roles) BEFORE calling the broker
#  - NO vendor key anywhere (only Authorization: Bearer)
set -euo pipefail

# --- placeholders (substitute at deploy time) ---
TENANT_ID="${TENANT_ID:-11111111-1111-1111-1111-111111111111}"                       # PLACEHOLDER
APP_ID_URI="${APP_ID_URI:-api://00000000-0000-0000-0000-000000000000}"               # PLACEHOLDER
BROKER_HOST="${BROKER_HOST:-broker.contoso.com}"
PATH_ARG="${1:-v1/health}"

# --- acquire a v2 broker token (spec §4.2: --scope, NOT --resource) ---
TOKEN=$(az account get-access-token --scope "${APP_ID_URI}/.default" --query accessToken -o tsv)
# mask the token in any captured output
echo "::add-mask::${TOKEN}" 2>/dev/null || true

# --- assert token claims BEFORE calling the broker (spec §12.1) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="$TOKEN" BROKER_SCOPE="${APP_ID_URI}" bash "${SCRIPT_DIR}/../test/token-claims-assert.sh" env

# --- call the broker (no vendor key, only Authorization: Bearer) ---
curl -fsS -w '\nHTTP_STATUS:%{http_code}\n' \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://${BROKER_HOST}/${PATH_ARG}"
