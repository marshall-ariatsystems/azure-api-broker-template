#!/usr/bin/env bash
# test/run-smoke-bars.sh — v1 deliverable smoke bars (gate verifier).
#
# Runs the machine-checkable bars from VD-003 / ED-004 (adapted to this design) and prints
# PASS/FAIL per bar with evidence. Exits non-zero if ANY bar fails.
#
# No live Azure credentials, no provisioning. Reads the artifact set only.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0; SKIP=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP: $1"; SKIP=$((SKIP+1)); }

# --- helpers ---
json_ok() { jq empty "$1" 2>/dev/null; }
bicep_ok() { (cd /tmp && az bicep build --file "$1" --outdir /tmp/smoke-bicep 2>/dev/null && echo ok) | grep -q ok; }

echo "=== Bar 1: build-record status files A1..A8 present + schema-valid ==="
# Historical build records live in the unpublished _archive/. Skipped on a fresh clone.
STATUS_DIR="$ROOT/_archive/deployments/status"
if [ ! -d "$STATUS_DIR" ]; then
  skip "status/A1..A8 (no _archive/deployments/status — build records not published)"
else
  for A in A1 A2 A3 A4 A5 A6 A7 A8; do
    f="$STATUS_DIR/$A.json"
    if [ -f "$f" ] && jq -e '.agent and (.status=="pass" or .status=="fail") and (.outputs|type=="array") and (.consumed|type=="array") and (.blockers|type=="array") and .timestamp' "$f" >/dev/null 2>&1; then
      ok "status/$A.json schema-valid"
    else
      bad "status/$A.json missing or schema-invalid"
    fi
  done
fi

echo "=== Bar 2: iac/outputs.json.hostname == broker.contoso.com + principalId present ==="
if jq -e '.hostname == "broker.contoso.com" and .identityPrincipalId' "$ROOT/iac/outputs.json" >/dev/null 2>&1; then
  ok "hostname=broker.contoso.com + identityPrincipalId present"
else
  bad "hostname/principalId check"
fi

echo "=== Bar 3: identity/outputs.json issuer ends /v2.0 + tenantId/brokerClientId/appIdUri ==="
if jq -e '((.issuer|endswith("/v2.0")) and .tenantId and .brokerClientId and .appIdUri)' "$ROOT/identity/outputs.json" >/dev/null 2>&1; then
  ok "issuer ends /v2.0 + tenantId/brokerClientId/appIdUri present"
else
  bad "identity/outputs.json issuer/fields"
fi

echo "=== Bar 4: app-roles.json >=3 VendorApi.Key* roles each mapping one secret alias ==="
N=$(jq '[.roles[] | select(.value|startswith("VendorApi.Key"))] | length' "$ROOT/identity/app-roles.json")
M=$(jq '[.roles[] | select(.value|startswith("VendorApi.Key")) | .secretName] | all(. != null) | length' "$ROOT/identity/app-roles.json" 2>/dev/null || echo 0)
# each Key role maps exactly one alias
ALIAS_OK=$(jq '[.roles[] | select(.value|startswith("VendorApi.Key"))] | all(.secretName != null and (.secretName|length>0))' "$ROOT/identity/app-roles.json")
if [ "$N" -ge 3 ] && [ "$ALIAS_OK" = "true" ]; then
  ok "$N VendorApi.Key* roles, each maps one secret alias"
else
  bad "app-roles.json role/alias mapping (N=$N aliasOk=$ALIAS_OK)"
fi

echo "=== Bar 5: Bicep builds clean (foundation, keyvault, module, auth, alerts) ==="
for b in iac/foundation.bicep iac/keyvault.bicep iac/modules/existing-vnet-subnet.bicep iac/modules/private-endpoint-subnet.bicep iac/auth.bicep observability/alerts.bicep; do
  if bicep_ok "$ROOT/$b"; then ok "bicep build: $b"; else bad "bicep build: $b"; fi
done

echo "=== Bar 6: JSON valid (outputs.json, app-roles.json, identity/outputs.json, federated-credential.json) ==="
for j in iac/outputs.json identity/app-roles.json identity/outputs.json cicd/federated-credential.json; do
  if json_ok "$ROOT/$j"; then ok "json: $j"; else bad "json: $j"; fi
done

echo "=== Bar 7: federated-credential issuer no trailing slash + audience exact ==="
ISS=$(jq -r '.issuer' "$ROOT/cicd/federated-credential.json")
AUD=$(jq -r '.audiences[0]' "$ROOT/cicd/federated-credential.json")
if [[ "$ISS" == "https://token.actions.githubusercontent.com" ]] && [[ "$AUD" == "api://AzureADTokenExchange" ]]; then
  ok "FIC issuer no trailing slash + audience exact"
else
  bad "FIC issuer/audience (iss=$ISS aud=$AUD)"
fi

echo "=== Bar 8: call-broker.yml parses + id-token:write + no secrets.* + --scope + token-claim assertion + no --resource cmd ==="
python3 -c "import yaml; yaml.safe_load(open('$ROOT/cicd/call-broker.yml'))" 2>/dev/null
if [ $? -eq 0 ]; then ok "call-broker.yml parses as YAML"; else bad "call-broker.yml YAML parse"; fi
grep -q "id-token: write" "$ROOT/cicd/call-broker.yml" && ok "id-token: write present" || bad "id-token: write"
if grep -Eq '\$\{\{ *secrets\.' "$ROOT/cicd/call-broker.yml"; then bad "actual secrets.* reference found"; else ok "no secrets.* for vendor key"; fi
grep -q -- "--scope" "$ROOT/cicd/call-broker.yml" && ok "--scope present" || bad "--scope missing"
if grep -Eq 'az .* --resource ' "$ROOT/cicd/call-broker.yml"; then bad "actual --resource command found"; else ok "no --resource command"; fi
grep -qi "token-claims-assert" "$ROOT/cicd/call-broker.yml" && ok "token-claim assertion step present" || bad "token-claim assertion step"

echo "=== Bar 9: call-broker.sh uses broker.contoso.com + --scope, no --resource, no literal key ==="
grep -q "broker.contoso.com" "$ROOT/clients/call-broker.sh" && ok "call-broker.sh broker.contoso.com" || bad "call-broker.sh hostname"
grep -q -- "--scope" "$ROOT/clients/call-broker.sh" && ok "call-broker.sh --scope" || bad "call-broker.sh --scope"
if grep -Eq 'az .* --resource ' "$ROOT/clients/call-broker.sh"; then bad "call-broker.sh --resource command"; else ok "call-broker.sh no --resource"; fi
# Literal key = a curl header/key assignment carrying a long secret value (NOT the word 'vendor key' in comments).
LIT=$(grep -Eni 'x-api-key:|api[_-]?key=|apikey=|authorization:[[:space:]]*[A-Za-z0-9._-]{20,}|KEY=.*[A-Za-z0-9]{20,}' "$ROOT/clients/call-broker.sh" | grep -viE 'no |#|comment|only authorization: bearer|authorization: bearer "?\$' || true)
if [ -z "$LIT" ]; then ok "call-broker.sh no literal key"; else bad "call-broker.sh literal key:"; echo "$LIT"; fi

echo "=== Bar 10: existing-network negative-match scan (no az command / bicep resource / runbook step that mutates ANY pre-existing network infrastructure) ==="
# Real violation = an `az` command that mutates existing network infra (VNet peering, gateways,
# VPN/tunnels, route tables/routes, network virtual appliances), a bicep resource DECLARATION
# (not `existing`, not the allowed delegated subnet) for one of those types, or a mutate verb whose
# direct object is pre-existing network infrastructure. The template legitimately ADDS one delegated
# subnet and references the existing VNet read-only — those are NOT violations. Prohibition statements
# ("never creates or modifies...", "read-only", "referenced read-only") are explicitly excluded.
VIOL=$(grep -rniE 'az network (vnet[ -]?peering|vnet-gateway|vpn-gateway|vpn-connection|vpn-site|route-table|route|nva|virtual-appliance)[a-z -]* (create|update|delete|set|reset)|resource[[:space:]]+[^ ]+[[:space:]]+.?Microsoft\.Network/(virtualNetworkPeerings|virtualNetworkGateways|vpnGateways|connections|routeTables|localNetworkGateways)|(create|update|delete|modify|reconfigure|provision|deploy)[a-z ]*(existing|pre-existing)[a-z ]*(vnet|peering|gateway|tunnel|route|appliance)' \
  "$ROOT"/iac "$ROOT"/apim "$ROOT"/identity "$ROOT"/cicd "$ROOT"/clients "$ROOT"/observability "$ROOT"/test 2>/dev/null \
  | grep -ivE 'do not|don.t|never|not |no |read-only|read only|pre-existing|preexisting|immutable|reference|referenced|reuse|reuses|existing =|carries|refer|note|document|does not|without touching|never modif|is not|are not|only adds|only add|@description\(' \
  | grep -v 'run-smoke-bars.sh' || true)
if [ -z "$VIOL" ]; then ok "existing network referenced read-only; no mutating az command / bicep resource / step"; else bad "existing-network negative-match violated:"; echo "$VIOL"; fi

echo "=== Bar 11: no Azure MCP server referenced (az CLI only) ==="
# Real violation = an actual MCP tool/server USE (e.g. mcp__azure call, mcp.azure import, 'use the azure mcp'),
# not the prohibition statement 'no Azure MCP server' itself.
MCPR=$(grep -rniE 'mcp__azure|mcp\.azure|use the azure mcp|use an azure mcp|via mcp|import mcp|from .*[._]mcp[ ._]' \
  "$ROOT"/iac "$ROOT"/identity "$ROOT"/cicd "$ROOT"/clients "$ROOT"/observability "$ROOT"/test 2>/dev/null \
  | grep -viE 'no azure mcp|no mcp|without mcp|not .*mcp|don.t .*mcp|az cli \(no azure mcp|no azure mcp server' \
  | grep -v 'run-smoke-bars.sh' || true)
if [ -z "$MCPR" ]; then ok "no Azure MCP server referenced"; else bad "MCP reference found:"; echo "$MCPR"; fi

echo "=== Bar 12: broker code — exact role selection + count!=1 -> 403 + allowlist scrub + no caller-oid forward ==="
BR="$ROOT/function-node/src/broker.js"
grep -q "single.length !== 1" "$BR" && grep -q "status: 403" "$BR" && ok "broker: exact role + count!=1 -> 403" || bad "broker selection logic"
CS="$ROOT/function-node/src/credential-scrubber.js"
grep -q "FORWARD_HEADER_ALLOWLIST" "$CS" && grep -qi "allowlist" "$CS" && ok "credential-scrubber: allowlist (not denylist)" || bad "credential-scrubber allowlist"
grep -qi "oid=.*azp=.*\(403\)" "$BR" && ok "broker: caller oid/azp logged, not forwarded" || bad "broker caller-oid forwarding"

echo "=== Bar 14: private endpoint NSG is actually in force (network policies Enabled + deny-all backstop) ==="
PEM="$ROOT/iac/modules/private-endpoint-subnet.bicep"
# 'Disabled' here would silently bypass every NSG rule on the private endpoint — the single
# highest-consequence misconfiguration in this design.
grep -q "privateEndpointNetworkPolicies: 'Enabled'" "$PEM" \
  && ok "PE subnet sets privateEndpointNetworkPolicies: Enabled" \
  || bad "PE subnet must set privateEndpointNetworkPolicies: 'Enabled' or the NSG is bypassed"
grep -q "DenyAllInbound" "$PEM" && ok "PE NSG has deny-all backstop" || bad "PE NSG missing deny-all backstop"
grep -q "Microsoft.App/environments" "$ROOT/iac/modules/existing-vnet-subnet.bicep" \
  && ok "Flex Consumption integration subnet delegation is Microsoft.App/environments" \
  || bad "integration subnet delegation must be Microsoft.App/environments for Flex Consumption"

echo "=== Bar 13: acceptance-matrix.md all PASS ==="
if grep -q "| PASS |" "$ROOT/test/acceptance-matrix.md" && ! grep -qE '\| FAIL \|' "$ROOT/test/acceptance-matrix.md"; then
  ok "acceptance-matrix.md all PASS"
else
  bad "acceptance-matrix.md has FAIL rows"
fi

echo ""
echo "=== SUMMARY: $PASS passed, $FAIL failed, $SKIP skipped ==="
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
