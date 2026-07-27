"""Pure, bearer-safe broker preflight helpers."""

from dataclasses import dataclass
import re
from urllib.parse import urlparse


class BrokerPreflightError(ValueError):
    """Raised when a non-secret broker setting is absent or invalid."""


_API_SCOPE_PATTERN = re.compile(r"^api://[^/\s]+/.+$")


@dataclass(frozen=True)
class BrokerPreflightConfig:
    base: str
    scope: str


def _required(environ, name):
    value = environ.get(name)
    if not isinstance(value, str) or not value.strip():
        raise BrokerPreflightError(f"{name} is required")
    return value.strip()


def validate_broker_config(environ):
    """Return trimmed required broker settings without introducing defaults."""
    base = _required(environ, "BROKER_BASE")
    scope = _required(environ, "BROKER_SCOPE")
    parsed = urlparse(base)
    if parsed.scheme != "https" or not parsed.netloc:
        raise BrokerPreflightError("BROKER_BASE must be an HTTPS URL")
    if (scope.startswith("api://") and not _API_SCOPE_PATTERN.fullmatch(scope)) or (
        not scope.startswith("api://") and any(character.isspace() for character in scope)
    ):
        raise BrokerPreflightError("BROKER_SCOPE is malformed")
    return BrokerPreflightConfig(base=base.rstrip("/"), scope=scope)


def run_preflight(config, acquire_token, invoke_preflight):
    """Invoke preflight with injected transport and expose only safe response fields."""
    token = acquire_token()
    response = invoke_preflight(config.base, token)
    return (response["status"], response["correlationId"])
