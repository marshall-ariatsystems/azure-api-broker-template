import ast
import importlib
import os
import socket
import unittest


try:
    broker_config = importlib.import_module("broker_config")
except ModuleNotFoundError:
    broker_config = importlib.import_module("clients.broker_config")
BrokerConfigError = broker_config.BrokerConfigError
load_broker_config = broker_config.load_broker_config
pin_dns = broker_config.pin_dns


VALID_ENV = {
    "BROKER_HOST": "broker.example.test",
    "BROKER_SCOPE": "api://00000000-0000-0000-0000-000000000000/.default",
    "BROKER_IP": "203.0.113.10",  # RFC 5737 TEST-NET-3 documentation address
}
VALID_ENV_NO_PIN = {
    "BROKER_HOST": "broker.example.test",
    "BROKER_SCOPE": "api://00000000-0000-0000-0000-000000000000/.default",
}
# Every required key removed, one at a time, must raise BrokerConfigError naming that key.
MISSING_CASES = ["BROKER_HOST", "BROKER_SCOPE"]
# Each malformed value must be rejected before any network primitive is touched.
MALFORMED_CASES = {
    "blank host": {"BROKER_HOST": "   ", "BROKER_SCOPE": "api://x/.default"},
    "http base":  {"BROKER_BASE": "http://broker.example.test", "BROKER_SCOPE": "api://x/.default"},
    "empty scope": {"BROKER_HOST": "broker.example.test", "BROKER_SCOPE": "  "},
    "bad ip":     {"BROKER_HOST": "broker.example.test",
                   "BROKER_SCOPE": "api://x/.default", "BROKER_IP": "not-an-ip"},
}
# Literals that must NOT appear anywhere under clients/ after this ED (S1 leakage markers).
FORBIDDEN_TOPOLOGY = [
    "func-broker-cxapi-csb2cscrdcdka3fy.centralus-01." "azurewebsites.net",
    "10.0." "0.10",
    "ce485d55-f7af-40a8-" "b9d3-12dd64252740",
]


class BrokerConfigTests(unittest.TestCase):
    def test_explicit_config_required(self):
        """explicit config required"""
        for key in MISSING_CASES:
            environ = VALID_ENV_NO_PIN.copy()
            environ.pop(key)
            with self.subTest(key=key), self.assertRaises(BrokerConfigError) as raised:
                load_broker_config(environ)
            self.assertIn(key, str(raised.exception))
            for marker in FORBIDDEN_TOPOLOGY:
                self.assertNotIn(marker, str(raised.exception))

    def test_malformed_config_rejected_before_network(self):
        """malformed config rejected before network"""
        original_getaddrinfo = socket.getaddrinfo
        original_socket = socket.socket

        def network_touched(*args, **kwargs):
            raise AssertionError("network touched")

        socket.getaddrinfo = network_touched
        socket.socket = network_touched
        try:
            for name, environ in MALFORMED_CASES.items():
                with self.subTest(name=name):
                    with self.assertRaises(BrokerConfigError):
                        load_broker_config(environ)
        finally:
            socket.getaddrinfo = original_getaddrinfo
            socket.socket = original_socket

    def test_no_shipped_production_topology(self):
        """no shipped production topology"""
        clients_dir = os.path.dirname(__file__)
        for filename in ("broker_config.py", "broker_client.py"):
            with open(os.path.join(clients_dir, filename), encoding="utf-8") as source:
                text = source.read()
            for marker in FORBIDDEN_TOPOLOGY:
                self.assertNotIn(marker, text)

    def test_no_import_time_dns_mutation(self):
        """no import-time dns mutation"""
        path = os.path.join(os.path.dirname(__file__), "broker_client.py")
        with open(path, encoding="utf-8") as source:
            tree = ast.parse(source.read())
        for statement in tree.body:
            if isinstance(statement, (ast.Assign, ast.AugAssign)):
                targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                for target in targets:
                    self.assertFalse(
                        isinstance(target, ast.Attribute)
                        and isinstance(target.value, ast.Name)
                        and target.value.id == "socket"
                        and target.attr == "getaddrinfo"
                    )
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
                call = statement.value
                if (
                    isinstance(call.func, ast.Attribute)
                    and isinstance(call.func.value, ast.Name)
                    and call.func.value.id == "os"
                    and call.func.attr == "getenv"
                    and len(call.args) > 1
                    and isinstance(call.args[0], ast.Constant)
                    and isinstance(call.args[0].value, str)
                    and call.args[0].value.startswith("BROKER_")
                ):
                    self.fail("broker configuration may not have an os.getenv default")

    def test_dns_pin_is_invocation_scoped(self):
        """dns pin is invocation scoped"""
        cfg = load_broker_config(VALID_ENV)
        original_getaddrinfo = socket.getaddrinfo
        with pin_dns(cfg):
            self.assertIsNot(socket.getaddrinfo, original_getaddrinfo)
        self.assertIs(socket.getaddrinfo, original_getaddrinfo)

        cfg_without_pin = load_broker_config(VALID_ENV_NO_PIN)
        with pin_dns(cfg_without_pin):
            self.assertIs(socket.getaddrinfo, original_getaddrinfo)
        self.assertIs(socket.getaddrinfo, original_getaddrinfo)


if __name__ == "__main__":
    unittest.main()
