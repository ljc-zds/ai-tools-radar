#!/usr/bin/env python3
"""One-time private browser migration. Never put its output inside extension/."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from urllib.parse import urlsplit
from gateway import load_kit

ROOT = Path(__file__).resolve().parent

def build_profile(kit_paths, llm_path, ledger_path):
    raw = json.loads(Path(llm_path).read_text())
    allowed = ('base_url', 'api_key', 'model', 'wire_api', 'reasoning_effort')
    llm = {k: raw[k] for k in allowed if k in raw}
    if not all(isinstance(llm.get(k), str) and llm[k].strip() for k in ('base_url','api_key','model')): raise ValueError()
    url = urlsplit(llm['base_url'])
    if url.scheme != 'https' or not url.hostname or url.username is not None or url.query or url.fragment: raise ValueError()
    llm['store'] = False
    kits=[];ids=set()
    for path in kit_paths:
        kit=load_kit(path,'unused');ids.add(kit['id'])
        kits.append({'product':{**kit['product'],'submitter':kit['submitter']},'copy':kit['copy'],'comment_voice':kit['comment_voice'],'compliance':{'forbidden_claims_regex':kit['forbidden']}})
    records=[]
    path=Path(ledger_path)
    if path.exists():
        db=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)
        db.row_factory=sqlite3.Row
        try:
            for row in db.execute('SELECT * FROM records'):
                if row['product_key'] not in ids:continue
                records.append({'productId':row['product_key'],'productUrl':row['product_url'],'url':row['url'],'state':row['state'],'updatedAt':row['updated_at'],'filledCount':row['filled_count'],'detail':row['detail'],'confirmedAt':row['confirmed_at'],'confirmationSource':row['confirmation_source']})
        finally:db.close()
    return {'schemaVersion':1,'llm':llm,'kits':kits,'ledger':records}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kit',action='append',type=Path)
    parser.add_argument('--llm',type=Path,default=ROOT/'.data/llm.json')
    parser.add_argument('--ledger',type=Path,default=ROOT/'.data/workflow.sqlite3')
    parser.add_argument('--output',type=Path,default=ROOT/'.data/browser-profile.json')
    args=parser.parse_args()
    try:
        output=args.output.resolve()
        if output.is_relative_to((ROOT/'extension').resolve()): raise ValueError()
        profile=build_profile(args.kit or [ROOT.parent/'outreach/kit.json'],args.llm,args.ledger)
        output.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        descriptor,temporary_name=tempfile.mkstemp(prefix='.browser-profile-',suffix='.tmp',dir=output.parent)
        temporary=Path(temporary_name)
        with os.fdopen(descriptor,'w') as file:json.dump(profile,file,ensure_ascii=False,indent=2)
        temporary.chmod(0o600);os.replace(temporary,output);output.chmod(0o600)
    except Exception:
        parser.exit(1,'迁移文件生成失败，请检查配置、产品资料和输出路径；未回显任何配置内容。\n')
    print(f'已生成私有迁移文件：{output}\n产品 {len(profile["kits"])} 个，历史工作记录 {len(profile["ledger"])} 条。请勿分享或放入 extension 目录。')
if __name__=='__main__':main()
