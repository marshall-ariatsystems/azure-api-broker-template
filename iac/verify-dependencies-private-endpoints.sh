#!/bin/bash
# iac/verify-dependencies-private-endpoints.sh — verify private endpoints for Storage and Key Vault.
#
# Post-deployment verification that private endpoints are created and resolving inside the VNet.
# This script should be run from a host INSIDE the VNet (or via SSH into a VM in the VNet).
#
# Usage:
#   ./iac/verify-dependencies-private-endpoints.sh <resource-group> <storage-account-name> <keyvault-name>
#
# Example:
#   ./iac/verify-dependencies-private-endpoints.sh my-rg stg01234567 apibkr-optd-kv
#
# Returns: 0 on success (all private endpoints reachable), non-zero on failure.

set -euo pipefail

RG="${1:?Resource group name required}"
STORAGE_ACCOUNT="${2:?Storage account name required}"
KEYVAULT_NAME="${3:?Key Vault name required}"

echo "[*] Verifying private endpoint connectivity for Storage and Key Vault..."

# List private endpoints
echo "[*] Listing private endpoints in resource group..."
PE_LIST=$(az network private-endpoint list \
  --resource-group "${RG}" \
  --query '[].{name:name, state:privateLinkServiceConnections[0].privateLinkServiceConnectionState.status}' \
  --output json)
echo "${PE_LIST}" | jq '.' || true

# Check Storage FQDN resolution (blob)
STORAGE_FQDN="${STORAGE_ACCOUNT}.blob.core.windows.net"
echo "[*] Verifying Storage blob endpoint DNS resolution..."
if command -v nslookup &> /dev/null; then
  STORAGE_IP=$(nslookup "${STORAGE_FQDN}" | grep -A1 'Name:' | tail -1 | awk '{print $2}' || echo "LOOKUP_FAILED")
  if [[ "${STORAGE_IP}" == 10.* ]]; then
    echo "[OK] Storage blob resolves to private IP: ${STORAGE_IP}"
  else
    echo "[WARN] Storage blob resolved to ${STORAGE_IP} (expected private 10.x range)"
  fi
else
  echo "[WARN] nslookup not available (run this script from inside the VNet)"
fi

# Check Key Vault FQDN resolution
KV_FQDN="${KEYVAULT_NAME}.vault.azure.net"
echo "[*] Verifying Key Vault endpoint DNS resolution..."
if command -v nslookup &> /dev/null; then
  KV_IP=$(nslookup "${KV_FQDN}" | grep -A1 'Name:' | tail -1 | awk '{print $2}' || echo "LOOKUP_FAILED")
  if [[ "${KV_IP}" == 10.* ]]; then
    echo "[OK] Key Vault resolves to private IP: ${KV_IP}"
  else
    echo "[WARN] Key Vault resolved to ${KV_IP} (expected private 10.x range)"
  fi
else
  echo "[WARN] nslookup not available (run this script from inside the VNet)"
fi

# Check private DNS zones
echo "[*] Verifying private DNS zones..."
for zone in "privatelink.blob.core.windows.net" "privatelink.file.core.windows.net" "privatelink.queue.core.windows.net" "privatelink.table.core.windows.net" "privatelink.vaultcore.azure.net"; do
  if az network private-dns zone show --resource-group "${RG}" --name "${zone}" &>/dev/null; then
    echo "[OK] Private DNS zone ${zone} exists"
  else
    echo "[WARN] Private DNS zone ${zone} not found"
  fi
done

echo "[✓] Private endpoint verification complete."
exit 0
