#!/usr/bin/env python3
"""broker_smoketest.py — validate the cxkey key-broker from a Python runtime using
DefaultAzureCredential, the same way your real app will authenticate.

PREREQ (on a box in CX_Production_vNET / on the Meraki VPN):
    az login                     # sign in as the user holding ONE vendor-key role
    pip install azure-identity requests
    python3 broker_smoketest.py

DefaultAzureCredential picks up: az login, VS Code, env vars, or a VM managed
identity — so this same code works locally, on a prod VM, and in CI.
"""
import base64, json, socket, sys
from azure.identity import DefaultAzureCredential
import requests

APP_ID = "ce485d55-f7af-40a8-b9d3-12dd64252740"
HOST = "func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net"
URL = f"https://{HOST}/api/broker/anything"
SCOPE = f"api://{APP_ID}/.default"          # /.default => v2 token
EXPECT_PRIVATE_IP = "10.0.0.10"

_p = {"pass": 0, "fail": 0}
def ok(m):  print(f"  ✅ {m}"); _p["pass"] += 1
def bad(m): print(f"  ❌ {m}"); _p["fail"] += 1
def hr():   print("-" * 64)

def jwt_claims(tok):
    payload = tok.split(".")[1]
    payload += "=" * (-len(payload) % 4)                 # pad base64url
    return json.loads(base64.urlsafe_b64decode(payload))

hr(); print("1) DNS — are we on the private path?"); hr()
try:
    ip = socket.gethostbyname(HOST)
    print(f"  {HOST} -> {ip}")
    ok(f"resolves to the private endpoint ({EXPECT_PRIVATE_IP})") if ip == EXPECT_PRIVATE_IP \
        else bad(f"does NOT resolve to {EXPECT_PRIVATE_IP} — likely off-VPN or DNS unwired; calls will fail")
except OSError as e:
    bad(f"DNS lookup failed: {e}")

hr(); print("2) Acquire a v2 token via DefaultAzureCredential"); hr()
try:
    token = DefaultAzureCredential().get_token(SCOPE).token
    c = jwt_claims(token)
    print(f"  token acquired (ver={c.get('ver')} aud={c.get('aud')})")
    print(f"  roles claim: {c.get('roles', '<none>')}")
    ok("v2 token") if c.get("ver") == "2.0" else bad(f"expected v2 token, got ver={c.get('ver')}")
except Exception as e:
    bad(f"token acquisition failed: {e}"); print("\nSUMMARY: aborted"); sys.exit(1)

def call(headers):
    r = requests.get(URL, headers=headers, timeout=20)
    try: body = r.json()
    except ValueError: body = None
    return r.status_code, body

hr(); print("Test A — valid token => 200 + server-side key injected"); hr()
try:
    code, body = call({"Authorization": f"Bearer {token}"})
    print(f"  HTTP {code}")
    if code == 200:
        h = (body or {}).get("headers", {})
        key = h.get("X-Api-Key") or h.get("Authorization") or "<none>"
        # Never print the credential itself — presence and length are enough evidence.
        shown = "<none>" if key == "<none>" else f"<redacted, {len(key)} chars>"
        print(f"  injected credential echoed by vendor: {shown}")
        ok("broker injected a key server-side") if key != "<none>" else bad("no injected credential echoed")
    else:
        bad(f"expected 200, got {code}: {str(body)[:300]}")
except requests.RequestException as e:
    bad(f"request failed: {e}")

hr(); print("Test B — no token => 401 from Easy Auth"); hr()
try:
    code, _ = call({})
    print(f"  HTTP {code}")
    ok("unauthenticated request rejected with 401") if code == 401 else bad(f"expected 401, got {code}")
except requests.RequestException as e:
    bad(f"request failed: {e}")

hr(); print("Test D — smuggled x-api-key => stripped"); hr()
try:
    code, body = call({"Authorization": f"Bearer {token}", "x-api-key": "attacker-supplied-key"})
    print(f"  HTTP {code}")
    if code == 200:
        key = (body or {}).get("headers", {}).get("X-Api-Key", "<none>")
        # Print only the verdict — this header may hold the real injected credential.
        shown = "attacker-supplied-key (LEAK)" if key == "attacker-supplied-key" else "<redacted — not the attacker value>"
        print(f"  vendor saw X-Api-Key: {shown}")
        ok("smuggled key stripped/overwritten") if key != "attacker-supplied-key" else bad("attacker key leaked — scrub failed")
    else:
        print(f"  (skipped strip-check; returned {code})")
except requests.RequestException as e:
    bad(f"request failed: {e}")

hr(); print(f"SUMMARY: {_p['pass']} passed, {_p['fail']} failed"); hr()
sys.exit(1 if _p["fail"] else 0)
