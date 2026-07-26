"""
cxkey broker client (Python) — turnkey, proxy model. The real vendor key NEVER leaves Azure.

Two one-line drop-ins:

  # LLM / OpenRouter (any OpenAI-compatible vendor):
  from broker_client import broker_openai
  client = broker_openai()                     # <-- the only line you change
  client.chat.completions.create(model="openai/gpt-4o-mini", messages=[...])

  # Any REST vendor (e.g. Salesforce):
  from broker_client import get, post
  r = get("/api/broker/v2/organizations")      # Entra-authed, key injected by the broker

How the proxy works: your request goes to the BROKER, carrying YOUR Microsoft Entra token in
Authorization (auto-acquired + auto-refreshed here). Azure Easy Auth validates it, then the broker
strips your token, selects the right vendor key from Key Vault by your app role, injects it
server-side, and forwards to the vendor. You never possess the vendor key.

The broker is private-only. This module pins the broker FQDN -> its private IP at the socket layer
(the code equivalent of `curl --resolve FQDN:443:10.0.0.10`), so it works regardless of the
caller's DNS/VPN state; TLS SNI and the Host header stay the FQDN, so the cert validates normally.
The pin is applied process-wide, so it also covers the OpenAI SDK (httpx), not just `requests`.

Config (env vars, all optional):
  BROKER_HOST   broker hostname (default: the cxkey broker FQDN)
  BROKER_IP     private endpoint IP to pin to (default: 10.0.0.10).
                Set to "" (empty) to use normal DNS instead — for on-prem/fixed-DNS callers,
                or once VPN DNS is fixed. No code change.
  BROKER_SCOPE  Entra scope (default: api://<appId>/.default)

Identity: DefaultAzureCredential — works with `az login`, a managed identity, or an env-var
service principal (AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET), no code change. That
identity must (a) hold a VendorApi.Key* app role and (b) have its client app-id in the broker's
Easy Auth allowedApplications.

Requires: pip install azure-identity requests   (plus  openai httpx  for broker_openai())
"""
import os
import socket

import requests
from azure.identity import DefaultAzureCredential

BROKER_HOST = os.getenv(
    "BROKER_HOST", "func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net"
)
BROKER_IP = os.getenv("BROKER_IP", "10.0.0.10")
BROKER_SCOPE = os.getenv(
    "BROKER_SCOPE", "api://ce485d55-f7af-40a8-b9d3-12dd64252740/.default"
)
BROKER_BASE = f"https://{BROKER_HOST}"          # requests helpers take full paths ("/api/broker/...")
BROKER_API = f"{BROKER_BASE}/api/broker"         # SDK base_url; vendor subpaths append here

# --- pin FQDN -> private IP process-wide (covers requests AND httpx/openai) ----
# Patching socket.getaddrinfo is the universal `--resolve`: every library that resolves
# BROKER_HOST gets BROKER_IP, while the hostname string (hence TLS SNI + cert check) is untouched.
if BROKER_IP:
    _orig_getaddrinfo = socket.getaddrinfo

    def _pinned_getaddrinfo(host, *args, **kwargs):
        if host == BROKER_HOST:
            host = BROKER_IP
        return _orig_getaddrinfo(host, *args, **kwargs)

    socket.getaddrinfo = _pinned_getaddrinfo

# One credential for the process. In dev this uses the Azure CLI login; in prod a managed
# identity / service principal with a direct app-role assignment. azure-identity caches and
# auto-refreshes the token internally, so get_token() per request is cheap.
_credential = DefaultAzureCredential()


def get_token() -> str:
    """Acquire a bearer token for the broker's audience."""
    return _credential.get_token(BROKER_SCOPE).token


# --- generic REST helpers (Salesforce and any other HTTP vendor) ----------------
# Persistent session -> HTTP keep-alive, so repeated calls reuse the TLS connection instead of
# paying a fresh handshake (~230 ms) every time. Cuts per-call broker overhead to ~70-100 ms.
_session = requests.Session()


def call(method: str, path: str, **kwargs) -> requests.Response:
    """Call the broker at <path> with an Entra bearer token injected (keep-alive)."""
    headers = {"Authorization": f"Bearer {get_token()}"}
    headers.update(kwargs.pop("headers", {}))
    if not path.startswith("/"):
        path = "/" + path
    return _session.request(
        method, f"{BROKER_BASE}{path}", headers=headers,
        timeout=kwargs.pop("timeout", 30), **kwargs,
    )


def get(path, **kw):
    return call("GET", path, **kw)


def post(path, **kw):
    return call("POST", path, **kw)


def put(path, **kw):
    return call("PUT", path, **kw)


def delete(path, **kw):
    return call("DELETE", path, **kw)


# --- one-line OpenAI-SDK factory (OpenRouter / any OpenAI-compatible vendor) ---
def broker_openai(**openai_kwargs):
    """Return an OpenAI-SDK client pointed at the broker. Drop-in for:
        client = OpenAI(api_key=..., base_url="https://openrouter.ai/api/v1")
    The api_key is a placeholder — the broker injects the real key in Azure; an httpx auth hook
    overwrites Authorization with a fresh Entra token per request (auto-refresh)."""
    import httpx  # lazy: only LLM callers need httpx/openai
    from openai import OpenAI

    class _EntraAuth(httpx.Auth):
        def auth_flow(self, request):
            request.headers["Authorization"] = f"Bearer {get_token()}"
            yield request

    return OpenAI(
        base_url=BROKER_API,
        api_key="broker-managed",  # never used; real key injected server-side
        http_client=httpx.Client(auth=_EntraAuth(), timeout=60.0),
        **openai_kwargs,
    )
