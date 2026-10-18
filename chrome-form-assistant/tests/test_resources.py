import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).resolve().parents[1] / 'gateway.py')
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
from resource_store import Catalog, Ledger, canonical_url, product_identity, list_resources

def product(url='https://tool.example/', name='Tool'):
    return {'id':product_identity(url), 'product':{'url':url,'name':name},'submitter':{},'copy':{},'forbidden':[]}

class Resources(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)
        rows=[{'post_url':'https://blog.example/post#one','status_now':'live','checked_at':'2026-08-29'}, {'post_url':'https://blog.example/post#two','status_now':'lost','checked_at':'2026-08-29'}, {'post_url':'https://blog.example/?p=42','status_now':'live','checked_at':'2026-08-29'}]
        library=[{'url':'https://blog.example/post?utm_source=x','title':'Duplicate','plat':'blog','seen':'2025'}, {'url':'https://candidate.example/?view=submit','title':'Candidate','plat':'cms','seen':'2024'}, {'url':'https://evil.example/?token=SECRET'}]+[{'url':f'https://candidate{i}.example/','title':f'Item{i}','plat':'blog','seen':'2024'} for i in range(20)]
        (self.root/'verified_blog_comments.json').write_text(json.dumps(rows)); (self.root/'library.json').write_text(json.dumps(library))
        self.catalog=Catalog(self.root); self.ledger=Ledger(self.root/'db'/'ledger.sqlite3'); self.kit=product()
    def tearDown(self):self.temp.cleanup()
    def test_canonical_and_sensitive_rejection(self):
        self.assertEqual(canonical_url('https://EXAMPLE.com:443/post?p=42&utm_source=x#comments'),'https://example.com/post?p=42')
        self.assertEqual(canonical_url('https://example.com/?view=submit'),'https://example.com/?view=submit')
        self.assertEqual(canonical_url('https://example.com/?id=b&id=a'),'https://example.com/?id=b&id=a')
        for fragment in ('#/submit', '#!submit'):
            with self.assertRaises(ValueError):canonical_url('https://example.com/' + fragment)
        for url in ('javascript:alert(1)','https://u:p@example.com/','https://example.com/?token=SECRET','https://example.com/?code=x','https://example.com/?email=a%40b.com','https://example.com/\nfoo'):
            with self.assertRaises(ValueError):canonical_url(url)
    def test_dedupe_conflict_labels_and_order(self):
        self.assertEqual(len(self.catalog.items),23)
        item=self.catalog.items['https://blog.example/post']
        self.assertEqual(item['status'],'unknown');self.assertTrue(item['statusConflict']);self.assertEqual(len(item['sources']),2)
        self.assertEqual(item['sources'][0]['reportedStatuses'],['live','lost'])
        self.assertIn('历史',item['sources'][0]['label']);self.assertIn('非已确认目录',self.catalog.items['https://candidate.example/?view=submit']['sources'][0]['label'])
        # Reversing input must preserve conflict result.
        path=self.root/'verified_blog_comments.json';rows=json.loads(path.read_text());path.write_text(json.dumps(list(reversed(rows))))
        self.assertEqual(Catalog(self.root).items['https://blog.example/post']['status'],'unknown')
    def test_filter_paging(self):
        one=list_resources(self.catalog,self.ledger,self.kit,{'page':1,'pageSize':10});two=list_resources(self.catalog,self.ledger,self.kit,{'page':2,'pageSize':10})
        self.assertEqual(one['total'],23);self.assertEqual(len(one['items']),10);self.assertFalse({x['url'] for x in one['items']} & {x['url'] for x in two['items']})
        self.assertEqual(list_resources(self.catalog,self.ledger,self.kit,{'type':'historical_blog'})['total'],2)
        self.assertEqual(list_resources(self.catalog,self.ledger,self.kit,{'status':'unknown'})['total'],1)
        self.assertEqual(list_resources(self.catalog,self.ledger,self.kit,{'query':'view=submit'})['total'],1)
        for raw in ({'page':True},{'page':0},{'pageSize':1000},{'state':'public'},{'type':[]},{'query':[]}):
            with self.assertRaises((ValueError,TypeError)):list_resources(self.catalog,self.ledger,self.kit,raw)
    def test_product_identity_persistence_terminal_and_domain(self):
        a=product();b=product('https://other.example/');url='https://blog.example/post'
        self.ledger.transition(a,{'url':url,'action':'filled','filledCount':2})
        self.assertEqual(Ledger(self.ledger.path).lookup(a['id'],url)['state'],'filled')
        self.assertEqual(self.ledger.lookup(b['id'],url)['state'],'candidate')
        self.assertEqual(product('https://TOOL.example:443/#foo')['id'],a['id'])
        self.ledger.transition(a,{'url':url,'action':'submitted','humanConfirmed':True})
        for action in ({'action':'undo'},{'action':'skipped'},{'action':'filled','filledCount':1}):
            self.assertEqual(self.ledger.transition(a,{'url':url,**action})['state'],'submitted')
        row=self.ledger.lookup(a['id'],url);self.assertEqual(row['confirmationSource'],'用户手动确认');self.assertTrue(row['confirmedAt'])
        self.assertEqual(self.ledger.lookup(a['id'],'https://blog.example/other')['sameDomainSubmittedCount'],1)
        self.assertEqual(list_resources(self.catalog,self.ledger,a,{'state':'submitted'})['total'],1)
    def test_partial_undo_validation_and_manual_visits(self):
        url='https://manual.example/page'
        for raw in ({'action':'filled','filledCount':0},{'action':'submitted','humanConfirmed':False},{'action':'public'}):
            with self.assertRaises(ValueError):self.ledger.transition(self.kit,{'url':url,**raw})
        self.assertEqual(self.ledger.transition(self.kit,{'url':url,'action':'filled','filledCount':1,'aborted':True})['state'],'review_needed')
        self.assertEqual(self.ledger.transition(self.kit,{'url':url,'action':'filled','filledCount':1})['state'],'filled')
        self.assertEqual(self.ledger.transition(self.kit,{'url':url,'action':'undo'})['state'],'review_needed')
        result=list_resources(self.catalog,self.ledger,self.kit,{'query':'manual.example'})
        self.assertEqual(result['total'],1);self.assertEqual(result['items'][0]['sources'][0]['file'],'local-ledger')
    def test_concurrent_terminal_guard(self):
        url='https://blog.example/post'
        def write(i):return self.ledger.transition(self.kit,{'url':url,'action':'submitted','humanConfirmed':True} if i==3 else {'url':url,'action':'filled','filledCount':1})
        with ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(write,range(15)))
        self.assertEqual(self.ledger.lookup(self.kit['id'],url)['state'],'submitted')
    def test_http_routes_auth_bad_bodies_and_validation_block(self):
        server=g.ThreadingHTTPServer(('127.0.0.1',0),g.Handler);server.token='t'*40;server.kits=[self.kit];server.catalog=self.catalog;server.ledger=self.ledger;server.gate=threading.BoundedSemaphore(1)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def post(path,raw,token=None):
            request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,json.dumps(raw).encode(),{'Origin':'chrome-extension://'+'a'*32,'Content-Type':'application/json','Authorization':'Bearer '+(server.token if token is None else token)})
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request) as r:return r.status,json.load(r)
            except urllib.error.HTTPError as e:return e.code,json.load(e)
        try:
            self.assertEqual(post('/resources',{'productId':self.kit['id']},'bad')[0],403)
            for raw in ([],None,'bad',2):self.assertEqual(post('/resources',raw)[0],400)
            self.assertEqual(post('/resources',{'productId':self.kit['id']})[1]['total'],23)
            self.assertEqual(post('/record',{'productId':self.kit['id'],'url':'https://blog.example/post','action':'submitted','humanConfirmed':True})[0],200)
            status,body=post('/validate',{'productId':self.kit['id'],'resourceUrl':'https://blog.example/post'})
            self.assertEqual(status,409)
            self.assertNotIn('t'*40,json.dumps(body))
        finally:server.shutdown();server.server_close()
if __name__=='__main__':unittest.main()
