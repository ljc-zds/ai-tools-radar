import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).resolve().parents[1] / 'gateway.py')
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
KIT = {'id':'p','product':{'name':'Tool','url':'https://example.com','categories':['Research']},'copy':{},'submitter':{'name':'Owner','email':'owner@example.com'},'forbidden':['guaranteed']}
def field(ident='f0', label='Comment', kind='textarea', **kwargs): return {'id':ident,'label':label,'type':kind,'maxLength':300,'options':[],**kwargs}
class FakeLLM:
    calls = []
    @staticmethod
    def load(): return {'key':'SECRET','url':'https://example.com/v1/chat/completions','models':['test']}
    @classmethod
    def urlopen(cls, req, timeout):
        cls.calls.append(json.loads(req.data))
        class Response:
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,n): return json.dumps({'choices':[{'message':{'content':json.dumps({'values':[{'id':'f0','value':'Specific useful comment.'}]})}}]}).encode()
        return Response()
class Tests(unittest.TestCase):
    def test_allowlisted_kit(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'kit.json';p.write_text(json.dumps({'product':{'name':'Tool','url':'https://example.com','api_key':'SECRET','submitter':{'name':'Owner','password':'SECRET'}},'_说明':'SECRET','copy':{'api_key':'SECRET','taglines':['honest']}}))
            self.assertNotIn('SECRET',json.dumps(g.load_kit(p,'p')))
    def test_strict_output(self):
        for values in ([{'id':'f99','value':'bad'}],[{'id':'f0','value':'guaranteed'}],[{'id':'f0','value':'x'*301}],[{'id':'f0','value':'a'},{'id':'f0','value':'b'}]):
            with self.assertRaises(ValueError):g.validate_values(values,[field()],KIT)
    def test_generate_identity_and_copy(self):
        result=g.generate({'mode':'blog','page':{'body':'Article about research.'},'fields':[field(),field('f1','Email','email')]},KIT,FakeLLM)
        self.assertEqual(result['values'],[{'id':'f1','value':'owner@example.com'},{'id':'f0','value':'Specific useful comment.'}])
        self.assertNotIn('owner@example.com',json.dumps(FakeLLM.calls[-1]))
    def test_no_article_no_comment(self):
        self.assertEqual(g.generate({'mode':'blog','page':{},'fields':[field()]},KIT,None)['values'],[])
    def test_name_role(self):
        self.assertEqual(g.role(field(label='Name',kind='text'),'directory'),'product')
        self.assertEqual(g.role(field(label='Name',kind='text'),'blog'),'name')
        self.assertEqual(g.role(field(label='Contact name',kind='text'),'directory'),'name')
    def test_unknown_left_blank(self):
        self.assertEqual(g.generate({'mode':'directory','page':{},'fields':[field(label='Phone',kind='text')]},KIT,None)['values'],[])
    def test_snapshot_strips_values(self):
        snap=g.validate_snapshot({'mode':'directory','page':{'password':'SECRET'},'fields':[field(value='SECRET')]})
        self.assertNotIn('SECRET',json.dumps(snap))
    def test_http_auth_origin_host(self):
        server=g.ThreadingHTTPServer(('127.0.0.1',0),g.Handler);server.token='t'*40;server.kits=[KIT];server.gate=threading.BoundedSemaphore(1)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def call(origin, token, host=None):
            headers={'Origin':origin,'Authorization':'Bearer '+token,'Content-Type':'application/json'}
            if host:headers['Host']=host
            req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/products',b'{}',headers)
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req) as r:return r.status,json.load(r)
            except urllib.error.HTTPError as e:return e.code,json.load(e)
        try:
            self.assertEqual(call('https://evil.test',server.token)[0],403)
            self.assertEqual(call('chrome-extension://'+'a'*32,'wrong')[0],403)
            self.assertEqual(call('chrome-extension://'+'a'*32,server.token,'evil.test')[0],403)
            status,data=call('chrome-extension://'+'a'*32,server.token)
            self.assertEqual(status,200);self.assertEqual(set(data['products'][0]),{'id','name'})
        finally:server.shutdown();server.server_close()
if __name__=='__main__':unittest.main()
