import gzip
import json
from pathlib import Path
import tempfile
import unittest
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from build_browser_assets import build

class BrowserAssets(unittest.TestCase):
    def test_all_detail_sources_dedup_dates_and_separate_product_seed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);data=root/'data';(data/'links').mkdir(parents=True)
            (data/'verified_blog_comments.json').write_text(json.dumps([{'post_url':'https://blog.example/post#one','status_now':'live','checked_at':'2026-08-29'}]))
            (data/'library.json').write_text(json.dumps([{'url':'https://library.example/','title':'Candidate','seen':'2026-01-01'}]))
            (data/'data.json').write_text(json.dumps({'https://NOT-A-SOURCE.example/':{}}))
            (data/'links/index.json').write_text(json.dumps([{'u':'https://NOT-A-SOURCE-INDEX.example/'}]))
            (data/'links/detail.json').write_text(json.dumps([{'u':'https://blog.example/post#two','s':'Duplicate','f':1767225600},{'u':'https://detail-only.example/?p=42','s':'Only detail','p':'cms','f':1767225600},{'u':'https://bad.example/?token=secret'}]))
            kit=root/'kit.json';kit.write_text(json.dumps({'product':{'name':'Product','url':'https://product.example/','submitter':{'name':'Owner','email':'owner@example.com','password':'DROP'}},'api_key':'DROP'}))
            output=root/'local-resources';seed=root/'extension/products.json';metadata=build(data,[kit],output,seed)
            self.assertEqual(metadata['uniqueURLs'],3);self.assertEqual(metadata['rawDetailRows'],3);self.assertEqual(metadata['rejectedDetailRows'],1);self.assertEqual(metadata['detailFiles'],1)
            aggregate=json.loads(gzip.decompress((output/'backlinks.json.gz').read_bytes()))
            detail=next(row for row in aggregate['rows'] if 'detail-only' in row[0]);self.assertTrue(detail[5].startswith('2026-01-01'));self.assertIn('links/detail.json',aggregate['sources'])
            self.assertNotIn('NOT-A-SOURCE',json.dumps(aggregate));self.assertNotIn('owner@example.com',json.dumps(aggregate));self.assertNotIn('DROP',seed.read_text());self.assertFalse((seed.parent/'backlinks.json.gz').exists())
    def test_refuse_catalog_inside_runtime_directory(self):
        with self.assertRaises(ValueError):build(ROOT/'unused',[],ROOT/'extension')
if __name__=='__main__':unittest.main()
