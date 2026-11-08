import importlib.util
import json
import http.client
import threading
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'codex_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
release = threading.Event()


class TestServer(ThreadingHTTPServer):
    def __init__(self, address, handler):
        super().__init__(('127.0.0.1', 0), handler)

    def serve_forever(self):
        thread = threading.Thread(target=super().serve_forever, daemon=True)
        thread.start()

        def request(endpoint):
            conn = http.client.HTTPConnection('127.0.0.1', self.server_port, timeout=10)
            body = {} if endpoint == 'health' else {'test': 'connection only; no page or product data'}
            conn.request('POST', '/' + endpoint, body=json.dumps(body), headers={
                'Host': '127.0.0.1:8795', 'Origin': 'chrome-extension://' + 'a' * 32,
                'Authorization': 'Bearer test-token', 'Content-Type': 'application/json'})
            response = conn.getresponse()
            raw = response.read()
            status = response.status
            conn.close()
            return status, json.loads(raw) if raw else None

        try:
            with ThreadPoolExecutor(max_workers=5) as pool:
                futures = [pool.submit(request, 'draft') for _ in range(5)]
                try:
                    for _ in range(100):
                        health = request('health')[1]
                        if health['active'] == 5:
                            break
                        time.sleep(.02)
                    assert health['capacity'] == 5 and health['active'] == 5
                    assert request('draft')[0] == 429
                finally:
                    release.set()
                assert all(future.result()[0] == 200 for future in futures)
            assert request('health')[1]['active'] == 0
        finally:
            release.set()
            self.shutdown()
            thread.join()


def fake_invoke(*args):
    assert release.wait(10)
    return {'ok': True}


with patch.object(bridge, 'ExclusiveBridgeServer', TestServer), \
        patch.object(bridge, 'invoke', side_effect=fake_invoke), \
        patch.object(bridge.shutil, 'which', return_value='fake-codex'), \
        patch.object(bridge.secrets, 'token_urlsafe', return_value='test-token'), \
        patch('sys.argv', ['bridge', '--extension-id', 'a' * 32]), patch('builtins.print'):
    bridge.main()
print('PASS: bridge accepts 5 concurrent requests, rejects excess and releases all slots')
