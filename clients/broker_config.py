"""Explicit, dependency-free configuration for the Python broker client."""

from __future__ import annotations

import contextlib
import ipaddress
import os
import socket
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import urlsplit


class BrokerConfigError(ValueError):
    """Raised when the broker's explicit configuration is absent or invalid."""


@dataclass(frozen=True)
class BrokerConfig:
    base_url: str
    scope: str
    pinned_ip: str | None
    host: str


def _value(environ: Mapping[str, str], key: str) -> str | None:
    value = environ.get(key)
    if value is None:
        return None
    return value.strip()


def _base_from_host(host: str) -> tuple[str, str]:
    if not host or "://" in host or any(char in host for char in "/?#@"):
        raise BrokerConfigError("BROKER_HOST must be a non-empty hostname")
    parsed = urlsplit(f"https://{host}")
    if not parsed.hostname:
        raise BrokerConfigError("BROKER_HOST must be a non-empty hostname")
    return f"https://{host}".rstrip("/"), parsed.hostname.lower()


def _base_from_url(base: str) -> tuple[str, str]:
    parsed = urlsplit(base)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise BrokerConfigError("BROKER_BASE must be an HTTPS URL with a host")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise BrokerConfigError("BROKER_BASE must be an HTTPS URL with a host")
    return base.rstrip("/"), parsed.hostname.lower()


def _valid_scope(scope: str) -> bool:
    if not scope:
        return False
    if not scope.startswith("api://"):
        return True
    parsed = urlsplit(scope)
    return bool(parsed.netloc and parsed.path and parsed.path != "/")


def load_broker_config(environ: Mapping[str, str] | None = None) -> BrokerConfig:
    """Load required broker settings from *environ* without any fallback values."""
    source = os.environ if environ is None else environ
    host = _value(source, "BROKER_HOST")
    base = _value(source, "BROKER_BASE")

    if host and base:
        raise BrokerConfigError("BROKER_HOST and BROKER_BASE are mutually exclusive")
    if host is not None and not host:
        raise BrokerConfigError("BROKER_HOST is required")
    if base is not None and not base:
        raise BrokerConfigError("BROKER_BASE is required")
    if host is None and base is None:
        raise BrokerConfigError("BROKER_HOST is required (or supply BROKER_BASE)")

    if host is not None:
        base_url, resolved_host = _base_from_host(host)
    else:
        base_url, resolved_host = _base_from_url(base or "")

    scope = _value(source, "BROKER_SCOPE")
    if not scope:
        raise BrokerConfigError("BROKER_SCOPE is required")
    if not _valid_scope(scope):
        raise BrokerConfigError("BROKER_SCOPE must be api://<broker-app-id>/.default or a non-empty scope")

    pinned_ip = _value(source, "BROKER_IP")
    if pinned_ip is not None:
        if not pinned_ip:
            raise BrokerConfigError("BROKER_IP must be a valid IP address when supplied")
        try:
            ipaddress.ip_address(pinned_ip)
        except ValueError as error:
            raise BrokerConfigError("BROKER_IP must be a valid IP address") from error

    return BrokerConfig(base_url=base_url, scope=scope, pinned_ip=pinned_ip, host=resolved_host)


@contextlib.contextmanager
def pin_dns(config: BrokerConfig):
    """Temporarily resolve the configured broker hostname to its configured IP."""
    if not config.pinned_ip:
        yield
        return

    original_getaddrinfo = socket.getaddrinfo

    def pinned_getaddrinfo(host, *args, **kwargs):
        if isinstance(host, str) and host.lower() == config.host:
            host = config.pinned_ip
        return original_getaddrinfo(host, *args, **kwargs)

    socket.getaddrinfo = pinned_getaddrinfo
    try:
        yield
    finally:
        socket.getaddrinfo = original_getaddrinfo
