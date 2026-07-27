"""Public-entry tests for the shipped Python broker client."""
import os
import sys
import types
import unittest
from unittest.mock import Mock, patch

# Keep these public-entry tests dependency-free: production still requires requests and
# azure-identity, while the transport/credential are replaced below before import.
try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    requests = types.ModuleType("requests")
    requests.Session = Mock
    sys.modules["requests"] = requests
try:
    from azure.identity import DefaultAzureCredential  # noqa: F401
except ModuleNotFoundError:
    azure = types.ModuleType("azure")
    identity = types.ModuleType("azure.identity")
    identity.DefaultAzureCredential = Mock
    azure.identity = identity
    sys.modules["azure"] = azure
    sys.modules["azure.identity"] = identity

try:
    from clients import broker_client
except ModuleNotFoundError:
    import broker_client


ENV = {"BROKER_BASE": "https://broker.example.test/api/broker", "BROKER_SCOPE": "api://broker/.default"}


def response(status, headers=None):
    value = Mock(status_code=status)
    value.headers = headers or {}
    return value


class BrokerClientIntegrationTests(unittest.TestCase):
    @patch.dict(os.environ, ENV, clear=True)
    @patch.object(broker_client, "get_token", return_value="broker-token")
    @patch.object(broker_client, "_session")
    @patch.object(broker_client.time, "sleep")
    @patch.object(broker_client.random, "uniform", return_value=0)
    def test_public_call_protects_auth_and_retries_only_reads(self, _jitter, sleep, session, token):
        session.request.side_effect = [response(429, {"Retry-After": "0"}), response(200)]
        result = broker_client.get("v2/organizations", headers={"X-Request-Id": "safe"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(session.request.call_count, 2)
        self.assertEqual(session.request.call_args.args[1], "https://broker.example.test/api/broker/v2/organizations")
        self.assertEqual(session.request.call_args.kwargs["headers"]["Authorization"], "Bearer broker-token")
        sleep.assert_called_once()
        for header in ("Authorization", "x-api-key", "Proxy-Authorization"):
            with self.subTest(header=header):
                with self.assertRaisesRegex(broker_client.BrokerConfigError, "credential-shaped"):
                    broker_client.get("v2/organizations", headers={header: "attacker"})
        session.request.reset_mock()
        session.request.side_effect = None
        session.request.return_value = response(429, {"Retry-After": "0"})
        self.assertEqual(broker_client.post("v2/write").status_code, 429)
        self.assertEqual(session.request.call_count, 1)

    @patch.dict(os.environ, ENV, clear=True)
    @patch.object(broker_client, "get_token", return_value="broker-token")
    @patch.object(broker_client, "_session")
    def test_public_preflight_uses_validated_config_and_safe_surface(self, session, token):
        session.request.return_value = response(403, {"x-correlation-id": "req-denied"})
        self.assertEqual(broker_client.preflight("ninjaone"), (403, "req-denied"))
        self.assertEqual(session.request.call_args.args[:2], ("GET", "https://broker.example.test/api/broker/preflight/ninjaone"))
        self.assertEqual(session.request.call_args.kwargs["headers"]["Authorization"], "Bearer broker-token")


if __name__ == "__main__":
    unittest.main()
