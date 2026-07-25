#!/usr/bin/env bash
# setup-pi.sh — bootstrap the cxkey broker client on a pi agent.
#
# Copy this dir (broker_client.py, test_broker.py, setup-pi.sh) to the pi, then run:
#   ./setup-pi.sh
#   nano broker.env          # paste the pi-agent client secret
#   source broker.env
#   .broker-venv/bin/python test_broker.py     # A/B/D/E should PASS
#
# The pi must be able to reach the broker's private IP (10.0.0.10) over the private VPN.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="${VENV:-$HERE/.broker-venv}"
BROKER_HOST="func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net"
BROKER_IP="10.0.0.10"

echo "[1/4] python venv -> $VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet openai httpx azure-identity requests

echo "[2/4] env template -> $HERE/broker.env"
if [ ! -f "$HERE/broker.env" ]; then
  cat > "$HERE/broker.env" <<'ENV'
# cxkey pi-agent identity (SP: cxkey-pi-agent). Fill AZURE_CLIENT_SECRET, then: source broker.env
export AZURE_TENANT_ID=6a776d8b-0d62-4acb-945a-a51042d17ac0
export AZURE_CLIENT_ID=1cea04a4-0e41-4959-a4f4-f4e36038d85f
export AZURE_CLIENT_SECRET=CHANGE_ME
# optional: export BROKER_IP=10.0.0.10   # set to "" to use normal DNS instead of the socket pin
ENV
  chmod 600 "$HERE/broker.env"
  echo "  created broker.env (chmod 600) — set AZURE_CLIENT_SECRET before sourcing"
else
  echo "  broker.env already exists — leaving it"
fi

echo "[3/4] broker reachability over VPN (expect HTTP 401 = reachable + auth active)"
code=$(curl -sS -m 6 --resolve "$BROKER_HOST:443:$BROKER_IP" \
  -o /dev/null -w '%{http_code}' "https://$BROKER_HOST/api/broker/" 2>/dev/null || echo "000")
if [ "$code" = "401" ]; then
  echo "  OK: broker reachable at $BROKER_IP (401 unauthenticated, as expected)"
elif [ "$code" = "000" ]; then
  echo "  WARN: no response from $BROKER_IP — is this pi on the private VPN?"
else
  echo "  note: got HTTP $code (reachable; not the expected 401 — check anyway)"
fi

echo "[4/4] done. Next:"
echo "  1) edit $HERE/broker.env  -> paste the pi-agent client secret into AZURE_CLIENT_SECRET"
echo "  2) source $HERE/broker.env"
echo "  3) $VENV/bin/python $HERE/test_broker.py   # expect A/B/D/E PASS"
echo
echo "Then in your app, the only integration line is:"
echo "    from broker_client import broker_openai; client = broker_openai()"
