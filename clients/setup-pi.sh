#!/usr/bin/env bash
# setup-pi.sh — bootstrap a Tessera broker client on a headless agent.
#
# Copy this dir (broker_client.py, test_broker.py, setup-pi.sh) to the pi, then run:
#   ./setup-pi.sh
#   nano broker.env          # fill your workload identity values
#   source broker.env
#   .broker-venv/bin/python test_broker.py     # A/B/D/E should PASS
#
# The pi must be able to reach its explicitly configured private endpoint over the VPN.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="${VENV:-$HERE/.broker-venv}"

echo "[1/4] python venv -> $VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet openai httpx azure-identity requests

echo "[2/4] env template -> $HERE/broker.env"
if [ ! -f "$HERE/broker.env" ]; then
  cat > "$HERE/broker.env" <<'ENV'
# Headless workload identity. Fill all values from your own deployment, then: source broker.env
export AZURE_TENANT_ID=<tenant-id>
export AZURE_CLIENT_ID=<workload-client-id>
export AZURE_CLIENT_SECRET=CHANGE_ME
# Set these deployment-specific values before using the client or reachability probe.
export BROKER_HOST="<function-app>.azurewebsites.net"
export BROKER_SCOPE="api://<broker-app-id>/.default"
# Optional: export BROKER_IP="<private-ip>" for invocation-scoped DNS pinning.
ENV
  chmod 600 "$HERE/broker.env"
  echo "  created broker.env (chmod 600) — set the workload identity values before sourcing"
else
  echo "  broker.env already exists — leaving it"
fi

echo "[3/4] broker reachability over VPN (expect HTTP 401 = reachable + auth active)"
if [ -n "${BROKER_HOST:-}" ] && [ -n "${BROKER_IP:-}" ]; then
  code=$(curl -sS -m 6 --resolve "$BROKER_HOST:443:$BROKER_IP" \
    -o /dev/null -w '%{http_code}' "https://$BROKER_HOST/api/broker/" 2>/dev/null || echo "000")
  if [ "$code" = "401" ]; then
    echo "  OK: broker reachable at configured BROKER_IP (401 unauthenticated, as expected)"
  elif [ "$code" = "000" ]; then
    echo "  WARN: no response from configured BROKER_IP — is this pi on the private VPN?"
  else
    echo "  note: got HTTP $code (reachable; not the expected 401 — check anyway)"
  fi
else
  echo "  skipped: set BROKER_HOST and BROKER_IP to run the reachability probe"
fi

echo "[4/4] done. Next:"
echo "  1) edit $HERE/broker.env  -> set the workload identity values"
echo "  2) source $HERE/broker.env"
echo "  3) $VENV/bin/python $HERE/test_broker.py   # expect A/B/D/E PASS"
echo
echo "Then in your app, the only integration line is:"
echo "    from broker_client import broker_openai; client = broker_openai()"
