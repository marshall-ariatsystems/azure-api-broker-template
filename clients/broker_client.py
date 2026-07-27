"""Python client for calling vendor APIs through an explicitly configured broker.

Configuration is required at call time:

  BROKER_HOST   broker hostname, or use BROKER_BASE instead
  BROKER_BASE   e.g. https://<function-app>.azurewebsites.net
  BROKER_SCOPE  e.g. api://<broker-app-id>/.default
  BROKER_IP     optional address to use for invocation-scoped DNS pinning

The real vendor key remains in the broker. Callers authenticate with Microsoft Entra;
the broker selects and injects vendor credentials server-side.

Requires: pip install azure-identity requests (plus openai httpx for broker_openai()).
"""

import os
import time
import random
from collections.abc import Mapping

import requests
from azure.identity import DefaultAzureCredential

try:  # Supports both ``import clients.broker_client`` and running from clients/.
    from .broker_config import BrokerConfigError, load_broker_config, pin_dns
except ImportError:
    from broker_config import BrokerConfigError, load_broker_config, pin_dns


# One credential for the process. azure-identity caches and refreshes tokens internally.
_credential = DefaultAzureCredential()
_session = requests.Session()

_CREDENTIAL_HEADERS = frozenset({
    "authorization", "proxy-authorization", "x-api-key", "api-key", "apikey", "api_key",
    "key", "access_token", "token", "subscription-key", "x-api-key-id", "x-api-secret",
    "x-key-id", "x-secret", "client_id", "client_secret",
})
_MAX_READ_RETRIES = 2
_JITTER_CEILING_SECONDS = 0.25


def get_token(config=None) -> str:
    """Acquire a bearer token for the explicitly configured broker audience."""
    cfg = config or load_broker_config(os.environ)
    return _credential.get_token(cfg.scope).token


def _caller_headers(headers) -> dict:
    if headers is None:
        return {}
    if not isinstance(headers, Mapping):
        raise TypeError("headers must be a mapping")
    result = dict(headers)
    for name in result:
        if str(name).lower() in _CREDENTIAL_HEADERS:
            raise BrokerConfigError(f"credential-shaped caller header is not allowed: {name}")
    return result


def _retry_after_seconds(response) -> float:
    value = response.headers.get("Retry-After", "1").strip()
    return float(value) if value.isdigit() else 1.0


def call(method: str, path: str, **kwargs) -> requests.Response:
    """Call the broker at *path* with an Entra bearer token injected.

    GET and HEAD use at most two bounded, Retry-After-led retries. Writes are sent once.
    """
    cfg = load_broker_config(os.environ)
    headers = _caller_headers(kwargs.pop("headers", None))
    headers["Authorization"] = f"Bearer {get_token(cfg)}"
    max_retries = kwargs.pop("max_retries", _MAX_READ_RETRIES)
    if not isinstance(max_retries, int):
        raise TypeError("max_retries must be an integer")
    max_retries = max(0, min(max_retries, _MAX_READ_RETRIES))
    timeout = kwargs.pop("timeout", 30)
    if not path.startswith("/"):
        path = "/" + path
    with pin_dns(cfg):
        for attempt in range(max_retries + 1):
            response = _session.request(
                method,
                f"{cfg.base_url}{path}",
                headers=headers,
                timeout=timeout,
                **kwargs,
            )
            if response.status_code != 429 or method.upper() not in {"GET", "HEAD"} or attempt == max_retries:
                return response
            time.sleep(_retry_after_seconds(response) + random.uniform(0, _JITTER_CEILING_SECONDS))


def preflight(route_slug: str) -> tuple[int, str | None]:
    """Run the authenticated no-side-effect broker authorization preflight."""
    if not isinstance(route_slug, str) or not route_slug or not all(char.islower() or char.isdigit() or char == "-" for char in route_slug):
        raise BrokerConfigError("route_slug must be a lowercase route slug")
    cfg = load_broker_config(os.environ)
    headers = {"Authorization": f"Bearer {get_token(cfg)}", "Accept": "application/json"}
    with pin_dns(cfg):
        response = _session.request("GET", f"{cfg.base_url}/preflight/{route_slug}", headers=headers, timeout=30)
    return response.status_code, response.headers.get("x-correlation-id")


def get(path, **kw):
    return call("GET", path, **kw)


def post(path, **kw):
    return call("POST", path, **kw)


def put(path, **kw):
    return call("PUT", path, **kw)


def delete(path, **kw):
    return call("DELETE", path, **kw)


def broker_openai(**openai_kwargs):
    """Return an OpenAI-SDK client configured to send requests through the broker."""
    import httpx  # lazy: only LLM callers need httpx/openai
    from openai import OpenAI

    cfg = load_broker_config(os.environ)
    if "default_headers" in openai_kwargs:
        _caller_headers(openai_kwargs["default_headers"])

    class _EntraAuth(httpx.Auth):
        def auth_flow(self, request):
            request.headers["Authorization"] = f"Bearer {get_token(cfg)}"
            yield request

    class _PinnedTransport(httpx.BaseTransport):
        def __init__(self):
            self._transport = httpx.HTTPTransport()

        def handle_request(self, request):
            with pin_dns(cfg):
                return self._transport.handle_request(request)

        def close(self):
            self._transport.close()

    return OpenAI(
        base_url=f"{cfg.base_url}/api/broker",
        api_key="broker-managed",  # never used; the broker injects the real key server-side
        http_client=httpx.Client(auth=_EntraAuth(), transport=_PinnedTransport(), timeout=60.0),
        **openai_kwargs,
    )
