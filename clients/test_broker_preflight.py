"""Stdlib-only fixture tests for bearer-safe broker preflight helpers."""

from contextlib import redirect_stdout
from io import StringIO
import unittest

from clients.broker_preflight import BrokerPreflightError, run_preflight, validate_broker_config


class _ContractStub:
    """Fixture stand-in for ED-V010-001's load_broker_config contract."""

    @staticmethod
    def load_broker_config(environ):
        return validate_broker_config(environ)


VALID = {
    "BROKER_BASE": " https://broker.example.test/api/broker/ ",
    "BROKER_SCOPE": " api://00000000-0000-0000-0000-000000000000/.default ",
}


class BrokerPreflightTests(unittest.TestCase):
    def test_python_config_required(self):
        """python config required"""
        config = _ContractStub.load_broker_config(VALID)
        self.assertEqual(config.base, "https://broker.example.test/api/broker")
        cases = (
            ({"BROKER_SCOPE": VALID["BROKER_SCOPE"]}, "BROKER_BASE"),
            ({"BROKER_BASE": VALID["BROKER_BASE"]}, "BROKER_SCOPE"),
            ({**VALID, "BROKER_BASE": "   "}, "BROKER_BASE"),
            ({**VALID, "BROKER_SCOPE": "  "}, "BROKER_SCOPE"),
            ({**VALID, "BROKER_BASE": "http://broker.example.test"}, "BROKER_BASE"),
            ({**VALID, "BROKER_SCOPE": "api:///bad"}, "BROKER_SCOPE"),
        )
        for environ, variable in cases:
            with self.subTest(variable=variable):
                try:
                    validate_broker_config(environ)
                except BrokerPreflightError as error:
                    self.assertIn(variable, str(error))
                    self.assertNotIn("DISTINCTIVE-BEARER", str(error))
                else:
                    self.fail(f"Expected BrokerPreflightError naming {variable}")

    def test_python_preflight_hides_bearer(self):
        """python preflight hides bearer"""
        config = validate_broker_config(VALID)
        stdout = StringIO()
        with redirect_stdout(stdout):
            result = run_preflight(
                config,
                lambda: "DISTINCTIVE-BEARER",
                lambda base, token: {
                    "status": 200,
                    "correlationId": "req-01HZ_client.abc-0001",
                    "authorization": "allowed",
                },
            )
        self.assertEqual(result, (200, "req-01HZ_client.abc-0001"))
        self.assertNotIn("DISTINCTIVE-BEARER", repr(result))
        self.assertNotIn("DISTINCTIVE-BEARER", stdout.getvalue())
        denied = run_preflight(
            config,
            lambda: "DISTINCTIVE-BEARER",
            lambda base, token: {
                "status": 403,
                "correlationId": "req-01HZ_client.abc-0002",
                "authorization": "role-denied",
            },
        )
        self.assertEqual(denied, (403, "req-01HZ_client.abc-0002"))


if __name__ == "__main__":
    unittest.main()
