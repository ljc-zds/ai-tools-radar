import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from prepare_browser_profile import build_profile
from resource_store import Ledger,product_identity

class BrowserProfile(unittest.TestCase):
    def test_sanitized_readonly_migration_and_private_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);kit=root/'kit.json';llm=root/'llm.json';ledger=root/'ledger.sqlite3';output=root/'profile.json'
            kit.write_text(json.dumps({'product':{'name':'Synthetic','url':'https://tool.example/','submitter':{'name':'Owner','email':'owner@example.com','password':'PRIVATE-DROP'},'api_key':'PRIVATE-DROP'},'copy':{'taglines':['Honest text'],'api_key':'PRIVATE-DROP'},'compliance':{'forbidden_claims_regex':['guaranteed']}}))
            llm.write_text(json.dumps({'base_url':'https://model.example/v1','api_key':'SYNTHETIC-KEY','model':'test','reasoning_effort':'low','wire_api':'responses','unknown_secret':'PRIVATE-DROP'}))
            store=Ledger(ledger);store.transition({'id':product_identity('https://tool.example/'),'product':{'name':'Synthetic','url':'https://tool.example/'}},{'url':'https://blog.example/post','action':'submitted','humanConfirmed':True})
            before=ledger.read_bytes();profile=build_profile([kit],llm,ledger)
            self.assertEqual(ledger.read_bytes(),before);self.assertNotIn('PRIVATE-DROP',json.dumps(profile));self.assertEqual(profile['llm']['api_key'],'SYNTHETIC-KEY');self.assertEqual(profile['ledger'][0]['state'],'submitted')
            result=subprocess.run([sys.executable,str(ROOT/'prepare_browser_profile.py'),'--kit',str(kit),'--llm',str(llm),'--ledger',str(ledger),'--output',str(output)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0);self.assertNotIn('SYNTHETIC-KEY',result.stdout+result.stderr);self.assertEqual(output.stat().st_mode & 0o777,0o600)
    def test_missing_legacy_ledger_is_not_created(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);kit=root/'kit.json';llm=root/'llm.json';missing=root/'missing.sqlite3'
            kit.write_text(json.dumps({'product':{'name':'Test','url':'https://tool.example/'}}));llm.write_text(json.dumps({'base_url':'https://model.example/v1','api_key':'SYNTHETIC','model':'test'}))
            self.assertEqual(build_profile([kit],llm,missing)['ledger'],[]);self.assertFalse(missing.exists())
if __name__=='__main__':unittest.main()
