#!/usr/bin/env bash
# test/token-claims-assert.sh — spec §12.1 mandatory runtime test.
#
# Decodes a REAL v2 broker token (from $TOKEN env, or freshly acquired) and asserts:
#   ver == 2.0
#   aud  == $EXPECTED_AUD  (GUID)  OR  api://$EXPECTED_AUD
#   iss  == https://login.microsoftonline.com/<tenant>/v2.0  (v2 endpoint)
#   exactly ONE recognized VendorApi.Key* role
#
# Usage:
#   test/token-claims-assert.sh            # acquire a token via $BROKER_SCOPE and assert
#   TOKEN=... test/token-claims-assert.sh   # assert an existing token
#   test/token-claims-assert.sh env         # use $TOKEN (already acquired) and $BROKER_SCOPE
#
# Microsoft Learn: access token claims reference
# https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
set -euo pipefail

EXPECTED_AUD="${EXPECTED_AUD:-00000000-0000-0000-0000-000000000000}"   # PLACEHOLDER broker client-id
EXPECTED_ISS="${EXPECTED_ISS:-https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0}"  # PLACEHOLDER tenant
BROKER_SCOPE="${BROKER_SCOPE:-api://00000000-0000-0000-0000-000000000000/.default}"   # PLACEHOLDER

if [ -z "${TOKEN:-}" ]; then
  TOKEN=$(az account get-access-token --scope "$BROKER_SCOPE" --query accessToken -o tsv)
fi
echo "::add-mask::${TOKEN}" 2>/dev/null || true

# Decode the JWT payload (base64url) without trusting the transport.
PAYLOAD=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' \
  | awk '{l=length($0)%4; if(l>0)for(i=0;i<4-l;i++)$0=$0"="; print}' | base64 -d 2>/dev/null)

VER=$(echo "$PAYLOAD"   | jq -r '.ver')
AUD=$(echo "$PAYLOAD"   | jq -r '.aud')
ISS=$(echo "$PAYLOAD"   | jq -r '.iss')
ROLES=$(echo "$PAYLOAD" | jq -r '(.roles // []) | join(",")')
echo "ver=$VER aud=$AUD iss=$ISS roles=$ROLES"

[ "$VER" = "2.0" ] || { echo "FAIL: not a v2 token (check requestedAccessTokenVersion + --scope)"; exit 1; }
[ "$AUD" = "$EXPECTED_AUD" ] || [ "$AUD" = "api://$EXPECTED_AUD" ] || { echo "FAIL: aud mismatch"; exit 1; }
[ "$ISS" = "$EXPECTED_ISS" ] || { echo "FAIL: iss mismatch (expected v2 issuer)"; exit 1; }
# Exactly one recognized vendor-key role, mirroring the broker's server-side check (spec §5.1).
N=$(echo "$ROLES" | tr ',' '\n' | grep -Ecx 'VendorApi\.Key[ABC]\.Invoke|VendorApi\.Admin\.Test' || true)
[ "$N" -eq 1 ] || { echo "FAIL: expected exactly one vendor-key role, found $N"; exit 1; }
echo "PASS: token claims valid for the broker"
