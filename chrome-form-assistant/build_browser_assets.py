#!/usr/bin/env python3
"""Read-only public backlink snapshot import; never read model configuration."""
import argparse
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path
from resource_store import Catalog, canonical_url
from gateway import load_kit
ROOT=Path(__file__).resolve().parent

def build(data_dir, kit_paths, output_dir, product_output=None):
    data_dir=Path(data_dir);output_dir=Path(output_dir)
    if output_dir.resolve().is_relative_to((ROOT/'extension').resolve()):raise ValueError('反链资源不能输出到扩展包')
    catalog=Catalog(data_dir)
    sources=[];source_ids={}
    def source_id(name):
        if name not in source_ids:source_ids[name]=len(sources);sources.append(name)
        return source_ids[name]
    rows=[];by_url={}
    for item in catalog.ordered:
        row=[item['url'],item['title'],1 if item['type']=='historical_blog' else 0,item['platform'],item['status'],item['observedAt'],[source_id(s['file']) for s in item['sources']],1 if item.get('statusConflict') else 0]
        by_url[row[0]]=len(rows);rows.append(row)
    detail_files=0;raw_details=0;rejected=0
    for path in sorted((data_dir/'links').glob('*.json')):
        if path.name=='index.json':continue
        detail_files+=1
        data=json.loads(path.read_text())
        if not isinstance(data,list):raise ValueError('详情快照格式无效')
        sid=source_id('links/'+path.name)
        for detail in data:
            raw_details+=1
            try:
                if not isinstance(detail,dict):raise ValueError()
                url=canonical_url(detail.get('u'))
            except (ValueError,UnicodeError):rejected+=1;continue
            title=detail.get('s') if isinstance(detail.get('s'),str) else ''
            platform=detail.get('p') if isinstance(detail.get('p'),str) else ''
            raw_date=detail.get('f')
            date=str(raw_date) if isinstance(raw_date,(str,int,float)) and not isinstance(raw_date,bool) else ''
            if date.replace('.','',1).isdigit():
                try: date=datetime.fromtimestamp(float(date),timezone.utc).isoformat(timespec='seconds')
                except (ValueError,OverflowError,OSError): date=''
            if url not in by_url:
                by_url[url]=len(rows);rows.append([url,title[:300] or url,0,platform[:80],'unverified',date[:80],[sid],0])
            else:
                row=rows[by_url[url]]
                if sid not in row[6]:row[6].append(sid)
                if not row[2] and date>row[5]:row[5]=date[:80]
    def raw_count(name):
        try:return len(json.loads((data_dir/name).read_text()))
        except OSError:return 0
    metadata={'schemaVersion':2,'uniqueURLs':len(rows),'historicalUnique':sum(r[2] for r in rows),'rawHistoricalRows':raw_count('verified_blog_comments.json'),'rawLibraryRows':raw_count('library.json'),'detailFiles':detail_files,'rawDetailRows':raw_details,'rejectedDetailRows':rejected,'sourceUnavailable':catalog.unavailable,'scope':'仅现有本地快照；每域名详情最多原快照100条，不代表全网。详情 u 为反链来源，不导入 data.json 目标域名。'}
    payload={'metadata':metadata,'sources':sources,'rows':rows}
    output_dir.mkdir(parents=True,exist_ok=True)
    (output_dir/'backlinks.json.gz').write_bytes(gzip.compress(json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode(),compresslevel=9,mtime=0))
    products=[]
    for path in kit_paths:
        kit=load_kit(path,'unused')
        products.append({'product':{**kit['product'],'submitter':kit['submitter']},'copy':kit['copy'],'comment_voice':kit['comment_voice'],'compliance':{'forbidden_claims_regex':kit['forbidden']}})
    product_output=Path(product_output) if product_output else ROOT/'extension/products.json'
    product_output.parent.mkdir(parents=True,exist_ok=True)
    product_output.write_text(json.dumps({'schemaVersion':1,'kits':products},ensure_ascii=False,separators=(',',':')))
    return metadata

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--data-dir',type=Path,default=ROOT.parent/'data');parser.add_argument('--kit',type=Path,action='append');parser.add_argument('--output-dir',type=Path,default=ROOT/'local-resources');args=parser.parse_args()
    try:metadata=build(args.data_dir,args.kit or [ROOT.parent/'outreach/kit.json'],args.output_dir)
    except Exception:parser.exit(1,'构建失败；请检查来源 JSON、产品资料与输出路径。未回显私有资料。\n')
    print(json.dumps(metadata,ensure_ascii=False))
if __name__=='__main__':main()
