#!/usr/bin/env bash
# broker-smoketest.sh — validate the key-broker end-to-end from a box on the
# broker's private on-prem/VPN ingress path, running as the currently-logged-in Entra user.
#
# PREREQ: on the test box, sign in as the identity that holds ONE vendor-key role:
#     az login            # sign in as a user holding a broker app role
#     az account show     # confirm the right user is active
# Then:  bash broker-smoketest.sh
#
# Needs: az, curl, jq. No secrets live in this file.
set -uo pipefail

# ---- config (broker identity + private hostname) ----
APP_ID="ce485d55-f7af-40a8-b9d3-12dd64252740"
BROKER_HOST="func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net"
BROKER_URL="https://${BROKER_HOST}/api/broker/anything"
SCOPE="api://${APP_ID}/.default"     # /.default => v2 token (NOT --resource, which is v1)
EXPECT_PRIVATE_IP="10.0.0.10"        # the private endpoint address

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
hr()   { printf '%s\n' "----------------------------------------------------------------"; }

hr; echo "0) Identity & environment"; hr
command -v az   >/dev/null || { echo "az not found";   exit 1; }
command -v curl >/dev/null || { echo "curl not found"; exit 1; }
command -v jq   >/dev/null || { echo "jq not found";   exit 1; }
WHO="$(az account show --query user.name -o tsv 2>/dev/null)" \
  && echo "  signed in as: $WHO" || { echo "  not logged in — run 'az login' first"; exit 1; }

hr; echo "1) DNS — are we on the private path?"; hr
RESOLVED="$(getent hosts "$BROKER_HOST" 2>/dev/null | awk '{print $1}' | head -1)"
echo "  $BROKER_HOST -> ${RESOLVED:-<unresolved>}"
if [ "$RESOLVED" = "$EXPECT_PRIVATE_IP" ]; then
  ok "resolves to the private endpoint ($EXPECT_PRIVATE_IP)"
else
  bad "does NOT resolve to $EXPECT_PRIVATE_IP — you're likely off-VPN or DNS isn't wired; calls will fail"
fi

hr; echo "2) Acquire a v2 token for the broker"; hr
TOKEN="$(az account get-access-token --scope "$SCOPE" --query accessToken -o tsv 2>/dev/null)"
if [ -n "${TOKEN:-}" ]; then
  VER="$(printf '%s' "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq -r '.ver // "?"')"
  AUD="$(printf '%s' "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq -r '.aud // "?"')"
  echo "  token acquired (ver=$VER aud=$AUD)"
  [ "$VER" = "2.0" ] && ok "v2 token" || bad "expected a v2 token, got ver=$VER"
else
  bad "could not get a token — check the scope and that this user is assigned to the app"; echo; exit 1
fi

hr; echo "Test A — valid token => 200 + server-side key injected"; hr
RESP="$(curl -sS -m 20 -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BROKER_URL" 2>/dev/null)"
CODE="$(printf '%s' "$RESP" | tail -1)"; BODY="$(printf '%s' "$RESP" | sed '$d')"
echo "  HTTP $CODE"
if [ "$CODE" = "200" ]; then
  KEY="$(printf '%s' "$BODY" | jq -r '.headers["X-Api-Key"] // .headers.Authorization // "<none>"' 2>/dev/null)"
  echo "  injected credential echoed by vendor: $KEY"
  [ "$KEY" != "<none>" ] && ok "broker injected a key server-side" \
                         || bad "no injected credential in the echoed request"
else
  bad "expected 200 (auth accepted + single role resolved); got $CODE"
  echo "  body: $(printf '%s' "$BODY" | head -c 300)"
fi

hr; echo "Test B — no token => 401 from Easy Auth (before our code)"; hr
CODE="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$BROKER_URL" 2>/dev/null)"
echo "  HTTP $CODE"
[ "$CODE" = "401" ] && ok "unauthenticated request rejected with 401" \
                    || bad "expected 401, got $CODE"

hr; echo "Test D — smuggled x-api-key => stripped, real key wins"; hr
RESP="$(curl -sS -m 20 -w '\n%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-api-key: attacker-supplied-key" \
  "$BROKER_URL" 2>/dev/null)"
CODE="$(printf '%s' "$RESP" | tail -1)"; BODY="$(printf '%s' "$RESP" | sed '$d')"
echo "  HTTP $CODE"
if [ "$CODE" = "200" ]; then
  KEY="$(printf '%s' "$BODY" | jq -r '.headers["X-Api-Key"] // "<none>"' 2>/dev/null)"
  echo "  vendor saw X-Api-Key: $KEY"
  [ "$KEY" != "attacker-supplied-key" ] && ok "smuggled key was stripped/overwritten" \
                                        || bad "attacker key leaked through — scrub failed"
else
  echo "  (skipped strip-check; call returned $CODE)"
fi

hr
echo "SUMMARY: $pass passed, $fail failed"
hr
exit $(( fail > 0 ? 1 : 0 ))
