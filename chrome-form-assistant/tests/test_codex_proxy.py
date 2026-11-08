import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'codex_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ProxyEnvironment(unittest.TestCase):
    def test_system_proxy_is_inherited_without_mutating_parent(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(bridge.os, 'name', 'nt'), \
                patch.object(bridge.urllib.request, 'getproxies_registry', return_value={
                    'http': 'http://127.0.0.1:7897', 'https': 'http://127.0.0.1:7897'}, create=True):
            env = bridge.codex_environment()
            self.assertEqual(env['HTTPS_PROXY'], 'http://127.0.0.1:7897')
            self.assertNotIn('HTTPS_PROXY', os.environ)

    def test_explicit_proxy_is_never_overridden(self):
        with patch.dict(os.environ, {'ALL_PROXY': 'socks5://localhost:1234'}, clear=True), \
                patch.object(bridge.os, 'name', 'nt'), \
                patch.object(bridge.urllib.request, 'getproxies_registry', create=True) as read:
            self.assertEqual(bridge.codex_environment()['ALL_PROXY'], 'socks5://localhost:1234')
            read.assert_not_called()

    def test_disabled_proxy_stays_disabled(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(bridge.os, 'name', 'nt'), \
                patch.object(bridge.urllib.request, 'getproxies_registry', return_value={}, create=True):
            self.assertNotIn('HTTPS_PROXY', bridge.codex_environment())


if __name__ == '__main__':
    unittest.main()
