"""Plugin-only configuration and wire adapters. Credentials never leave the gateway."""
import json
from pathlib import Path
import ssl
import urllib.request
from urllib.parse import urlsplit, urlunsplit


def endpoint(base, wire):
    parts = urlsplit(base)
    path = parts.path.rstrip('/')
    for suffix in ('/chat/completions', '/responses'):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
            break
    if not path:
        path = '/v1'
    return urlunsplit((parts.scheme, parts.netloc,
                      path + ('/responses' if wire == 'responses' else '/chat/completions'),
                      parts.query, ''))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def tls_context():
    # Python.org macOS installations can have an empty trust store until their
    # certificate setup script is run. Add a verified CA bundle, never disable TLS.
    context = ssl.create_default_context()
    if context.cert_store_stats()['x509_ca'] == 0:
        try:
            import certifi
            context.load_verify_locations(cafile=certifi.where())
        except ImportError:
            if Path('/etc/ssl/cert.pem').is_file():
                context.load_verify_locations(cafile='/etc/ssl/cert.pem')
    return context


class PluginLLM:
    def __init__(self, legacy, path):
        self.legacy = legacy
        self.path = Path(path)

    def load(self):
        if not self.path.exists():
            return self.legacy.load()
        raw = json.loads(self.path.read_text())
        if not isinstance(raw, dict):
            raise ValueError('插件 LLM 配置无效。')
        base = raw.get('base_url')
        key = raw.get('api_key')
        model = raw.get('model')
        wire = raw.get('wire_api', 'responses')
        effort = raw.get('reasoning_effort', 'low')
        if (not all(isinstance(v, str) and v.strip() for v in (base, key, model))
                or wire not in ('responses', 'chat_completions')
                or effort not in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')):
            raise ValueError('插件 LLM 配置无效。')
        origin = self.legacy.origin_of(base)
        if origin[0] != 'https' and not self.legacy._is_loopback(origin[1]):
            raise ValueError('远程模型服务必须使用 HTTPS。')
        return {'url': endpoint(base, wire), 'key': key.strip(), 'models': [model.strip()],
                'wire_api': wire, 'reasoning_effort': effort, 'store': False}

    def urlopen(self, request, timeout=40):
        handlers = [NoRedirect(), urllib.request.HTTPSHandler(context=tls_context())]
        if self.legacy._is_loopback(urlsplit(request.full_url).hostname):
            handlers.append(urllib.request.ProxyHandler({}))
        return urllib.request.build_opener(*handlers).open(request, timeout=timeout)


def request_body(cfg, model, system, data):
    content = json.dumps(data, ensure_ascii=False)
    if cfg.get('wire_api') == 'responses':
        return {'model': model, 'instructions': system,
                'input': [{'role': 'user', 'content': 'Return a JSON object for this data:\n' + content}],
                'reasoning': {'effort': cfg.get('reasoning_effort', 'low')},
                'store': False, 'stream': False, 'max_output_tokens': 3000,
                'text': {'format': {'type': 'json_object'}}}
    body = {'model': model, 'messages': [{'role': 'system', 'content': system},
                                       {'role': 'user', 'content': content}],
            'max_tokens': 3000}
    if cfg.get('reasoning_effort'):
        body.update(reasoning_effort=cfg['reasoning_effort'], store=False)
    else:
        body['temperature'] = .4
    return body


def response_text(payload, wire):
    if wire != 'responses':
        return payload['choices'][0]['message']['content']
    if payload.get('status') not in (None, 'completed') or payload.get('error'):
        raise ValueError('模型未完成响应。')
    chunks = [part['text'] for item in payload.get('output', [])
              if isinstance(item, dict) and item.get('type') == 'message'
              and item.get('role') == 'assistant'
              for part in item.get('content', [])
              if isinstance(part, dict) and part.get('type') == 'output_text'
              and isinstance(part.get('text'), str)]
    if not chunks:
        raise ValueError('模型没有返回可用文本。')
    return ''.join(chunks)
