import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from llm_client import PluginLLM, endpoint, request_body, response_text, tls_context

spec = importlib.util.spec_from_file_location('legacy_config_for_test',
    ROOT.parent / 'outreach/llm_config.py')
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class LLMClient(unittest.TestCase):
    def test_plugin_configuration_isolated_and_pinned(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'llm.json'
            path.write_text(json.dumps({'base_url': 'https://provider.example/v1',
                'api_key': 'synthetic-key', 'model': 'gpt-5.6-sol',
                'wire_api': 'responses', 'reasoning_effort': 'low', 'store': True}))
            wrapped = Mock(wraps=legacy)
            cfg = PluginLLM(wrapped, path).load()
            wrapped.load.assert_not_called()
            self.assertEqual(cfg['url'], 'https://provider.example/v1/responses')
            self.assertEqual(cfg['models'], ['gpt-5.6-sol'])
            self.assertEqual(cfg['reasoning_effort'], 'low')
            self.assertFalse(cfg['store'])

    def test_missing_plugin_config_preserves_existing_config(self):
        fallback = Mock()
        fallback.load.return_value = {'models': ['old-model']}
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(PluginLLM(fallback, Path(folder) / 'missing.json').load(),
                             {'models': ['old-model']})

    def test_reasoning_request_has_json_and_no_sampling_or_key(self):
        cfg = {'wire_api': 'responses', 'reasoning_effort': 'low', 'key': 'DO-NOT-EMBED'}
        body = request_body(cfg, 'gpt-5.6-sol', 'System rules', {'article': 'Facts'})
        self.assertEqual(body['model'], 'gpt-5.6-sol')
        self.assertEqual(body['reasoning'], {'effort': 'low'})
        self.assertFalse(body['store'])
        self.assertFalse(body['stream'])
        self.assertIn('json', body['input'][0]['content'].lower())
        self.assertNotIn('temperature', body)
        self.assertNotIn('DO-NOT-EMBED', json.dumps(body))
        self.assertNotIn('messages', body)

    def test_output_ignores_reasoning_and_rejects_incomplete_or_refusal(self):
        payload = {'status': 'completed', 'output': [
            {'type': 'reasoning', 'content': [{'type': 'output_text', 'text': 'IGNORE'}]},
            {'type': 'message', 'role': 'assistant', 'content': [
                {'type': 'output_text', 'text': '{"values":[]}'},
            ]}]}
        self.assertEqual(json.loads(response_text(payload, 'responses')), {'values': []})
        for change in ({'status': 'incomplete'}, {'error': {'code': 'failed'}}, {'output': []}):
            with self.assertRaises(ValueError):
                response_text({**payload, **change}, 'responses')

    def test_urls_do_not_duplicate_wire_suffix(self):
        for base in ('https://provider.example', 'https://provider.example/v1/',
                     'https://provider.example/v1/chat/completions',
                     'https://provider.example/v1/responses'):
            self.assertEqual(endpoint(base, 'responses'), 'https://provider.example/v1/responses')

    def test_tls_verification_stays_enabled(self):
        import ssl
        context = tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)


if __name__ == '__main__':
    unittest.main()
