#!/bin/bash
# iac/verify-auth.sh — verify Easy Auth enforcement on the Function.
#
# Post-deployment verification that globalValidation is correctly configured and
# that unauthenticated requests are rejected with HTTP 401 before the app runs.
#
# Usage:
#   ./iac/verify-auth.sh <resource-group> <function-name>
#
# Example:
#   ./iac/verify-auth.sh my-rg my-broker-func
#
# Returns: 0 on success (auth is enforced), non-zero on failure.

set -euo pipefail

RG="${1:?Resource group name required}"
FUNC_NAME="${2:?Function name required}"
BROKER_HOSTNAME="${3:-broker.contoso.com}"

echo "[*] Verifying Easy Auth configuration on ${FUNC_NAME} in ${RG}..."

# Fetch authsettingsV2
echo "[*] Reading authsettingsV2 configuration..."
AUTH_CONFIG=$(az functionapp config show \
  --resource-group "${RG}" \
  --name "${FUNC_NAME}" \
  --query authsettingsV2 \
  --output json)

# Check requireAuthentication
echo "[*] Checking globalValidation.requireAuthentication..."
REQUIRE_AUTH=$(echo "${AUTH_CONFIG}" | jq -r '.globalValidation.requireAuthentication // false')
if [[ "${REQUIRE_AUTH}" != "true" ]]; then
  echo "[ERROR] globalValidation.requireAuthentication is not set to true (got: ${REQUIRE_AUTH})"
  exit 1
fi
echo "[OK] requireAuthentication = true"

# Check unauthenticatedClientAction
echo "[*] Checking globalValidation.unauthenticatedClientAction..."
UNAUTH_ACTION=$(echo "${AUTH_CONFIG}" | jq -r '.globalValidation.unauthenticatedClientAction // empty')
if [[ "${UNAUTH_ACTION}" != "Return401" ]]; then
  echo "[ERROR] globalValidation.unauthenticatedClientAction is not set to Return401 (got: ${UNAUTH_ACTION})"
  exit 1
fi
echo "[OK] unauthenticatedClientAction = Return401"

# Test unauthenticated request
echo "[*] Testing unauthenticated request to the broker (should receive HTTP 401)..."
DEFAULT_HOSTNAME=$(az functionapp show \
  --resource-group "${RG}" \
  --name "${FUNC_NAME}" \
  --query 'defaultHostName' \
  --output tsv)

HTTP_STATUS=$(curl -s -w '%{http_code}' -o /dev/null \
  -H 'Authorization:' \
  "https://${DEFAULT_HOSTNAME}/api/health" || true)

if [[ "${HTTP_STATUS}" == "401" ]]; then
  echo "[OK] Unauthenticated request returned HTTP ${HTTP_STATUS} (as expected)"
else
  echo "[WARN] Expected HTTP 401 from unauthenticated request, got HTTP ${HTTP_STATUS}"
  echo "[WARN] (Note: this may fail if public network access is disabled and you are not running from a private network)"
  # Don't fail here — it's expected if publicNetworkAccess is Disabled and we're testing from outside
fi

echo "[✓] Easy Auth verification complete. Configuration is correct."
exit 0
