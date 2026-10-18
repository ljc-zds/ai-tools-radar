"""Synthetic gateway for sidepanel integration tests. Does not load user kits or model config."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
spec=importlib.util.spec_from_file_location('gateway',Path(__file__).resolve().parents[1]/'gateway.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
from resource_store import Catalog,Ledger,product_identity
class FakeLLM:
    @staticmethod
    def load():return {'key':'synthetic-test-key','url':'https://synthetic.invalid/','models':['test']}
    @staticmethod
    def urlopen(request,timeout):
        fields=json.loads(json.loads(request.data)['messages'][1]['content'])['fields']
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,n):return json.dumps({'choices':[{'message':{'content':json.dumps({'values':[{'id':f['id'],'value':'Transparent citations make research easier to evaluate.'} for f in fields]})}}]}).encode()
        return Response()
with tempfile.TemporaryDirectory() as temp:
    root=Path(temp)
    (root/'verified_blog_comments.json').write_text(json.dumps([{'post_url':'http://resource.test/post','status_now':'live','checked_at':'2026-08-29'}]))
    (root/'library.json').write_text(json.dumps([{'url':f'http://candidate{i}.test/','title':f'Candidate {i}','plat':'cms','seen':'2026-08-01'} for i in range(13)]))
    kits=[{'id':product_identity(f'https://product{i}.example/'),'product':{'name':f'Test Product {i}','url':f'https://product{i}.example/'},'submitter':{'name':'Test Owner','email':'test@example.com'},'copy':{},'forbidden':[]} for i in range(2)]
    server=g.ThreadingHTTPServer(('127.0.0.1',0),g.Handler);server.kits=kits;server.catalog=Catalog(root);server.ledger=Ledger(root/'ledger.sqlite3');server.token='synthetic_pairing_token_for_test_only_12345678';server.gate=threading.BoundedSemaphore(1);server.llm=FakeLLM
    print(json.dumps({'port':server.server_port,'token':server.token}),flush=True)
    server.serve_forever()
