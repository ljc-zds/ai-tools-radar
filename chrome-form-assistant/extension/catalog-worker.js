/* Local files only. This worker never fetches catalog URLs or model configuration. */
importScripts('url-utils.js');
const canonicalURL=URLTools.canonicalURL;
const LIMIT=128*1024*1024;
let cached,dbPromise;
const changes=new BroadcastChannel('manual-form-resources');changes.onmessage=()=>{cached=undefined;};
function db(){
 if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
  const req=indexedDB.open('manual-form-assistant-v3',2);
  req.onupgradeneeded=()=>{const value=req.result;for(const name of ['config','products','sources'])if(!value.objectStoreNames.contains(name))value.createObjectStore(name,{keyPath:'id'});if(!value.objectStoreNames.contains('records')){const store=value.createObjectStore('records',{keyPath:['productId','url']});store.createIndex('productId','productId');}};
  let blocked=false;req.onblocked=()=>{blocked=true;reject(Error('关闭旧插件页并刷新扩展后再读取文件。'));};
  req.onsuccess=()=>{if(blocked){req.result.close();return;}req.result.onversionchange=()=>req.result.close();resolve(req.result);};req.onerror=()=>reject(Error('本地文件数据库不可用。'));
 });return dbPromise;
}
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(Error('本地资源读取失败。'));});
async function current(){if(cached!==undefined)return cached;const value=await db();cached=await request(value.transaction('sources','readonly').objectStore('sources').get('active'))||null;return cached;}
function index(source){if(!source)return;source.index=new Map();source.search=source.rows.map((row,i)=>{source.index.set(row[0],i);const browserURL=new URL(row[0]).href;if(!source.index.has(browserURL))source.index.set(browserURL,i);return(row[0]+' '+row[1]+' '+row[3]).toLocaleLowerCase();});}
function meta(source){return source?{name:source.name,size:source.size,lastModified:source.lastModified,importedAt:source.importedAt,linked:!!source.handle,metadata:source.metadata}:null;}
function parseCSV(text){
 const rows=[];let row=[],value='',quoted=false,closed=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closed=true;}}else value+=c;continue;}
  if(c==='"'){if(value||closed)throw Error('CSV 引号格式无效。');quoted=true;continue;}
  if(c===','||c==='\n'||c==='\r'){row.push(value);value='';closed=false;if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(v=>v.trim()))rows.push(row);row=[];}continue;}
  if(closed&&c.trim())throw Error('CSV 引号格式无效。');
  if(!closed)value+=c;
 }
 if(quoted)throw Error('CSV 引号未闭合。');
 row.push(value);if(row.some(v=>v.trim()))rows.push(row);
 if(!rows.length)throw Error('CSV 文件为空。');
 const aliases=new Set(['url','post_url','u','source_url','backlink_url','sourceurl','referringpageurl','链接','网址','来源url']);
 const headers=rows[0].map(v=>v.trim().toLocaleLowerCase().replace(/[\s-]/g,''));
 const urlIndex=headers.findIndex(h=>aliases.has(h));
 if(urlIndex<0){if(rows.every(r=>r.length===1))return rows.map(r=>({url:r[0].trim()}));throw Error('CSV 需要 URL、post_url、u 或来源URL列。');}
 return rows.slice(1).map(row=>Object.fromEntries(headers.map((h,i)=>[i===urlIndex?'url':h,row[i]||''])));
}
function date(raw){if(typeof raw==='number'||typeof raw==='string'&&/^\d+(?:\.\d+)?$/.test(raw)){const value=new Date(Number(raw)*1000);return Number.isFinite(value.getTime())?value.toISOString():'';}return typeof raw==='string'?raw.slice(0,80):'';}
async function textOf(file){
 if(!file||typeof file.stream!=='function'||file.size>LIMIT)throw Error('请选择不超过 128 MiB 的本地文件。');
 let stream=file.stream();if(/\.gz$/i.test(file.name))stream=stream.pipeThrough(new DecompressionStream('gzip'));
 const reader=stream.getReader(),decoder=new TextDecoder();let result='',size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>LIMIT){await reader.cancel();throw Error('解压后文件超过 128 MiB。');}result+=decoder.decode(value,{stream:true});}
 return(result+decoder.decode()).replace(/^\uFEFF/,'');
}
function normalize(raw,filename){
 let input,sourceNames=[],upstream=null;
 if(typeof raw==='string')input=raw.split(/\r?\n/).map(url=>url.trim()).filter(Boolean).map(url=>({url}));
 else if(Array.isArray(raw))input=raw;
 else if(raw&&Array.isArray(raw.rows)&&Array.isArray(raw.sources)){input=raw.rows;sourceNames=raw.sources.map(v=>typeof v==='string'?v.slice(0,500):'未知来源');upstream=raw.metadata;}
 else if(raw&&Array.isArray(raw.items))input=raw.items;
 else if(raw&&Array.isArray(raw.links))input=raw.links;
 else throw Error('不支持该资源文件结构。请选择外链 JSON/CSV/TXT；模型迁移文件不是外链文件。');
 const names=[],nameIds=new Map(),rows=[],byURL=new Map();let rejected=0,accepted=0;
 const sourceID=name=>{name=String(name||filename).slice(0,500);if(!nameIds.has(name)){nameIds.set(name,names.length);names.push(name);}return nameIds.get(name);};
 for(const entry of input){
  let url,title='',historical=false,platform='',status='unverified',observedAt='',sources=[filename],conflict=false;
  try{
   if(Array.isArray(entry)){url=entry[0];title=entry[1];historical=entry[2]===1;platform=entry[3];status=entry[4];observedAt=entry[5];sources=Array.isArray(entry[6])?entry[6].map(i=>sourceNames[i]||filename):[filename];conflict=!!entry[7];}
   else if(typeof entry==='string')url=entry;
   else if(entry&&typeof entry==='object'){
    url=entry.post_url||entry.u||entry.url||entry.source_url||entry.backlink_url;title=entry.title||entry.s||'';historical=!!entry.post_url||entry.type==='historical_blog';platform=entry.plat||entry.p||entry.platform||'';status=historical?(entry.status_now||entry.status):'unverified';observedAt=entry.checked_at||entry.first_seen||entry.seen||entry.f||entry.observedAt||'';
    if(Array.isArray(entry.sources))sources=entry.sources.map(s=>s?.file||filename);
   }else throw Error();
   url=canonicalURL(url);
   title=typeof title==='string'?title.slice(0,300):'';platform=typeof platform==='string'?platform.slice(0,80):'';
   status=historical&&['live','lost','unknown'].includes(status)?status:historical?'unknown':'unverified';observedAt=date(observedAt);accepted++;
   const ids=[...new Set(sources.map(sourceID))];
   if(!byURL.has(url)){byURL.set(url,rows.length);rows.push([url,title||url,historical?1:0,platform,status,observedAt,ids,conflict?1:0]);}
   else{
    const old=rows[byURL.get(url)];old[6]=[...new Set([...old[6],...ids])];
    if(historical&&(!old[2]||observedAt>old[5])){old[2]=1;old[4]=status;old[5]=observedAt;old[7]=conflict?1:0;}
    else if(historical&&old[2]&&observedAt===old[5]&&status!==old[4]){old[4]='unknown';old[7]=1;}
    else if(!old[2]&&observedAt>old[5])old[5]=observedAt;
   }
  }catch{rejected++;}
 }
 if(!rows.length)throw Error('文件中没有可用的 HTTP/HTTPS 外链 URL；原资源文件保持不变。');
 const allowed=['rawHistoricalRows','rawLibraryRows','detailFiles','rawDetailRows','rejectedDetailRows','scope'];
 const provenance=upstream&&typeof upstream==='object'?Object.fromEntries(allowed.filter(k=>typeof upstream[k]==='number'||typeof upstream[k]==='string').map(k=>[k,typeof upstream[k]==='string'?upstream[k].slice(0,500):upstream[k]])):{};
 return{rows,sources:names,metadata:{...provenance,rawRows:input.length,acceptedRows:accepted,rejectedRows:rejected,uniqueURLs:rows.length,historicalUnique:rows.filter(row=>row[2]).length}};
}
async function importFile(file,handle){
 const text=await textOf(file);let raw;
 if(/\.csv(?:\.gz)?$/i.test(file.name))raw=parseCSV(text);
 else if(/\.txt(?:\.gz)?$/i.test(file.name))raw=text;
 else{try{raw=JSON.parse(text);}catch{throw Error('外链 JSON 格式无效；原资源文件保持不变。');}}
 const normalized=normalize(raw,file.name);
 const source={id:'active',name:file.name.slice(0,500),size:file.size,lastModified:file.lastModified,importedAt:new Date().toISOString(),handle:handle||null,...normalized};
 const value=await db();await new Promise((resolve,reject)=>{const tx=value.transaction('sources','readwrite');tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(Error('本地资源保存失败；原资源文件保持不变。'));try{tx.objectStore('sources').put(source);}catch{tx.abort();}});
 cached=source;index(cached);changes.postMessage({changed:true});return meta(cached);
}
function item(data,row){return{url:row[0],domain:new URL(row[0]).hostname,title:row[1],type:row[2]?'historical_blog':'candidate',platform:row[3],status:row[4],observedAt:row[5],sources:row[6].map(id=>({file:data.sources[id]})),statusConflict:!!row[7]};}
self.onmessage=async({data:message})=>{
 try{
  if(message.kind==='import'){postMessage({id:message.id,result:await importFile(message.file,message.handle)});return;}
  const data=await current();let result;
  if(message.kind==='meta')result=meta(data);
  else if(message.kind==='handle')result=data?.handle||null;
  else if(message.kind==='lookup'){if(data&&!data.index)index(data);const pos=data?.index.get(message.url);result=pos===undefined?null:item(data,data.rows[pos]);}
  else if(message.kind==='search'){
   if(data&&!data.index)index(data);
   const {query='',type='all',state='all',status='all',page=1,pageSize=10,records=[]}=message,states=new Map(records.map(row=>[row.url,row.state]));
   const q=query.trim().toLocaleLowerCase(),matches=[];let total=0;const start=(page-1)*pageSize;
   for(let i=0;i<(data?.rows.length||0);i++){
    const row=data.rows[i];if(type!=='all'&&type!==(row[2]?'historical_blog':'candidate')||state!=='all'&&state!==(states.get(row[0])||'candidate')||status!=='all'&&status!==row[4]||q&&!data.search[i].includes(q))continue;
    if(total>=start&&matches.length<pageSize)matches.push(item(data,row));total++;
   }
   result={items:matches,total,page,pageSize,metadata:data?.metadata||null,source:meta(data),sourceUnavailable:[]};
  }else throw Error('未知资源操作。');
  postMessage({id:message.id,result});
 }catch(error){postMessage({id:message.id,error:error.message||'本地文件读取或查询失败，请重新选择文件。'});}
};
