// Isolated headless Chrome; mock browser tabs and bridge, real extension DOM/storage APIs.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../extension'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'backlink-test-'));
const stub=`window.chrome={runtime:{id:'test',getURL:p=>location.origin+'/'+p},storage:{local:{setAccessLevel:async()=>{},get:async key=>({[key]:JSON.parse(localStorage.getItem('test:'+key)||'null')}),set:async data=>{for(const [k,v]of Object.entries(data))localStorage.setItem('test:'+k,JSON.stringify(v));}}},permissions:{request:async()=>true,contains:async()=>true},tabs:{query:async()=>[{id:1,url:window.testActiveURL||'https://hotellobby.ai/zh'}],create:async()=>({id:1}),get:async()=>({id:1,status:'complete'}),remove:async()=>{},onUpdated:{addListener(){},removeListener(){}}},scripting:{executeScript:async()=>[{result:{url:'https://blog.test/post',evidence:{forms:[{comment:true,website:true,submit:true,captcha:false}],notices:[]},items:[{text:'A thoughtful comment',sites:['https://author.test/']}],more:false}}]}};`;
const server=http.createServer((req,res)=>{
 const file=path.join(root,new URL(req.url,'http://test').pathname==='/'?'sidepanel.html':new URL(req.url,'http://test').pathname.slice(1));
 if(!file.startsWith(root)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 let data=fs.readFileSync(file);if(file.endsWith('sidepanel.html'))data=Buffer.from(data.toString().replace('<head>','<head><script>'+stub+'</script>'));
 res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/json');res.end(data);
});
let chrome,ws;
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 chrome=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 const portFile=path.join(profile,'DevToolsActivePort');
 for(let i=0;i<100&&!fs.existsSync(portFile);i++)await new Promise(r=>setTimeout(r,100));
 const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
 const tab=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let id=0;const pending=new Map(),errors=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,m=>m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result));ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:540,height:950,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/sidepanel.html`});
 for(let i=0;i<100;i++){if(await evaluate(`typeof scanner!=='undefined'&&!!scanner&&document.getElementById('product')?.options.length>0&&!busy`))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(await evaluate(`!!scanner && $('product').options.length>0`),true,'panel initialized');
 assert.equal(await evaluate(`$('semrushTarget').value`),'hotellobby.ai');
 assert.equal(await evaluate(`(async()=>{window.testActiveURL='https://sem.3ue.co/analytics/backlinks/backlinks/?q=pixverse.ai';await refreshCurrentWebsite();return $('semrushTarget').value;})()`),'pixverse.ai');
 assert.equal(await evaluate(`(async()=>{$('semrushTarget').value='manual.test';$('semrushTarget').dispatchEvent(new Event('input'));window.testActiveURL='https://newsite.test/post';await refreshCurrentWebsite();return $('semrushTarget').value;})()`),'manual.test');
 assert.equal(await evaluate(`(async()=>{await refreshCurrentWebsite(true);return $('semrushTarget').value;})()`),'newsite.test');
 assert.equal(await evaluate(`websiteContext('edge://extensions/')`),null);
 assert.equal(await evaluate(`websiteContext('https://ahrefs.com/backlink-checker/?input=https%3A%2F%2Fexample.org%2F').domain`),'example.org');

 await evaluate(`(async()=>{
 localStorage.setItem('codexBridgeToken','synthetic-test-token');
 discoveryRequest=async(path,data)=>(data.test||path==='health')?{ok:true,capacity:5}:{topics:['美食','生活'],verdict:'likely_guest',reason:'Enabled guest comment form'};
 collectSemrush=async domain=>({target:domain,rows:[{url:'https://child.test/post',title:'Child blog'}]});
 await saveCollected('target.test',[{url:'https://blog.test/post',title:'Blog article'}]);
 $('recursionRounds').value='1';await afterCollection([{url:'https://blog.test/post'}]);
 })()`);
 const result=await evaluate(`({jobs:scanJobs, tasks:JSON.parse(localStorage.getItem('test:'+recursionKey)), comments:JSON.parse(localStorage.getItem('test:'+blogKey))})`);
 assert.equal(result.jobs.length,2);assert(result.jobs.every(j=>j.state==='done'));
 assert.deepEqual(result.jobs[0].topics,['美食','生活']);assert.deepEqual(JSON.parse(await evaluate(`localStorage.getItem('test:'+scanKey)`))[0].topics,['美食','生活']);
 assert.equal(result.jobs[0].remaining,1);assert.equal(result.jobs[1].remaining,0);
 assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].domain,'author.test');
 assert.equal(result.comments[0].items.length,1);
 assert.equal(await evaluate(`libraryFilter='ready';renderAhrefs();document.querySelectorAll('.library-card').length`),2);
 assert.equal(await evaluate(`libraryFilter='profile';renderAhrefs();document.querySelectorAll('.library-card').length`),1);
 // Real publication queue and ledger, simulated submit responses (no external comments).
 const publish=await evaluate(`(async()=>{
   $('publishDomain').value='my-real-site.test';$('publisherName').value='Test Owner';$('publisherEmail').value='owner@my-real-site.test';
   window.publishedCalls=[];
   automation.openAuthorized=async url=>{
     window.publishedCalls.push(url);
     const productId=$('product').value,attemptId=crypto.randomUUID();
     await api('/record',{productId,url,attemptId,action:'attempt'});
     await api('/record',{productId,url,attemptId,action:'result',state:'outcome_unknown',evidence:'Synthetic unknown outcome'});
   };
   await publishLibrary();
   const first=window.publishedCalls.length;
   await publishLibrary();
   return {first,total:window.publishedCalls.length,unique:new Set(window.publishedCalls).size,records:[...libraryRecords.values()]};
 })()`);
 assert.equal(publish.first,1,'stop immediately after unknown result');
 assert.equal(publish.total,2);assert.equal(publish.unique,2,'locked target never retried');
 assert(publish.records.every(r=>r.state==='outcome_unknown'));
 // Reset display to a different product; submission states must be product-specific.
 await evaluate(`(async()=>{$('product').selectedIndex=0;await refreshLibraryRecords();})()`);
 await evaluate(`libraryFilter='ready';showPane('libraryPane');renderAhrefs()`);
 const shot=await call('Page.captureScreenshot',{format:'png'});
 const shotPath=path.join(os.tmpdir(),'backlink-library-v010.png');fs.writeFileSync(shotPath,Buffer.from(shot.data,'base64'));
 const evidence=await evaluate(`(()=>{
   const frame=document.createElement('iframe');document.body.append(frame);const win=frame.contentWindow;
   win.document.open();win.document.write('<div id="comments"><form id="commentform"><label>Comment<textarea name="comment"></textarea></label><input name="url"><button type="submit">Submit</button></form><div class="comment-body" id="div-comment-123"><div class="comment-author"><a class="url" href="https://author.test/">Author</a></div><div class="comment-content">This is a meaningful synthetic comment for verification.<a href="https://product.test/" rel="ugc nofollow">Product</a></div></div><button type="button" id="more">Load more comments</button></div>');win.document.close();
   win.document.getElementById('more').onclick=()=>{win.didExpand=true;};
   const page=win.eval('('+readBlogEvidence.toString()+')(true)');
   const action=win.eval('('+advanceCollection.toString()+')(' + JSON.stringify('comments') + ')');
   win.chrome={runtime:{id:'test',onMessage:{addListener(fn){win.handler=fn;}}}};
   win.eval(${JSON.stringify(fs.readFileSync(path.join(root,'content.js'),'utf8'))});
   let response;win.handler({kind:'submissionResult',payload:{body:'This is a meaningful synthetic comment for verification.',website:'https://product.test/',sourcePath:win.location.pathname,baseline:[],notices:[]}}, {id:'test'},value=>{response=value;});
   const submit=win.document.querySelector('button[type=submit]');submit.textContent='Next';submit.onclick=e=>{e.preventDefault();win.badSubmit=true;};
   const next=win.document.createElement('button');next.textContent='Next page';next.onclick=()=>{win.didNext=true;};win.document.body.append(next);
   const reportLocation={hostname:'sem.3ue.co',pathname:'/analytics/backlinks/backlinks/',origin:'https://sem.3ue.co',href:'https://sem.3ue.co/analytics/backlinks/backlinks/?q=target.test&ba_rpp=blog&ba_mt=active&ba_rel=ugc'};
   const reportAction=win.Function('location','return ('+advanceCollection.toString()+')("semrush")')(reportLocation);
   const result={methods:page.evidence.linkMethods,links:page.items[0].links,expanded:win.didExpand,action,response,reportAction,didNext:win.didNext,badSubmit:!!win.badSubmit};frame.remove();return result;
 })()`);
 assert(evidence.methods.includes('website_field'));assert(evidence.methods.includes('existing_body_links'));
 assert.equal(evidence.expanded,true);assert.equal(evidence.action.kind,'expand');
 assert.deepEqual(evidence.links[0].rel,['ugc','nofollow']);
 assert.equal(evidence.response.data.linkCheck.found,true);assert.deepEqual(evidence.response.data.linkCheck.links[0].rel,['ugc','nofollow']);
 assert.equal(evidence.reportAction.advanced,true);assert.equal(evidence.didNext,true);assert.equal(evidence.badSubmit,false);
 const formats=await evaluate(`(()=>{
   const frame=document.createElement('iframe');document.body.append(frame);const w=frame.contentWindow;
   const scan=html=>{w.document.body.innerHTML=html;return w.eval('('+readBlogEvidence.toString()+')(true)');};
   const wrap=html=>'<div id="comments"><div role="form" class="comment-editor">'+html+'<button type="button">Post comment</button></div></div>';
   const custom=scan(wrap('<div contenteditable="true" aria-label="Comment"></div><button type="button" aria-label="Insert link">Link</button>'));
   const plain=scan(wrap('<textarea aria-label="Comment"></textarea>'));
   const hints=scan(wrap('<textarea aria-label="Comment"></textarea><p>Allows links in comments.</p>'));
   const denied=scan(wrap('<textarea aria-label="Comment"></textarea><p>No links allowed. Supports HTML.</p>'));
   const existing=scan(wrap('<textarea aria-label="Comment"></textarea><div class="comment-body"><div class="comment-content">Useful <a href="https://author.test/path">reference</a></div></div>'));
   const articleOnly=scan(wrap('<textarea aria-label="Comment"></textarea>')+'<article><a href="https://author.test/path">reference</a></article>');
   const blocked=scan(wrap('<textarea aria-label="Comment"></textarea><input name="website"><div data-sitekey="synthetic"></div>'));
   const login=scan(wrap('<textarea aria-label="Comment"></textarea><input name="website"><p class="must-log-in">Login to post</p>'));
   const hidden=scan(wrap('<div contenteditable="true" aria-label="Comment" style="display:none"></div><input name="website">'));
   frame.remove();
   return {custom,plain,hints,denied,existing,articleOnly,blocked,login,hidden,
     eligible:[custom,plain,hints,denied,existing,articleOnly,blocked,login,hidden].map(p=>guestEvidenceEligible(p.evidence))};
 })()`);
 assert.deepEqual(formats.eligible,[true,false,true,false,true,false,false,false,false]);
 assert.equal(formats.custom.evidence.forms[0].custom,true);
 assert.equal(formats.existing.evidence.forms[0].website,false);
 const frames=await evaluate(`(async()=>{
   const original=chrome.scripting.executeScript;
   const base={forms:[],notices:[],linkMethods:[]};
   const child={url:'https://comments.test/widget',frames:[],items:[],evidence:{...base,forms:[{comment:true,submit:true,bodyLinks:true}],linkMethods:['comment_body_link']}};
   const top={url:'https://blog.test/post',frames:[{url:child.url}],items:[],evidence:base};
   try{
     chrome.scripting.executeScript=async()=>[{frameId:0,result:top},{frameId:9,result:child}];
     const visible=await readBlogPage(1);
     chrome.scripting.executeScript=async()=>[{frameId:0,result:{...top,frames:[]}},{frameId:9,result:child}];
     const hidden=await readBlogPage(1);
     chrome.scripting.executeScript=async()=>[{frameId:0,result:top}];
     const denied=await readBlogPage(1);
     chrome.scripting.executeScript=async()=>[{frameId:0,result:top},{frameId:9,result:child},{frameId:10,result:child}];
     const ambiguous=await readBlogPage(1);
     return {visible,hidden,denied,ambiguous};
   }finally{chrome.scripting.executeScript=original;}
 })()`);
 assert.equal(frames.visible.evidence.forms[0].frameId,9);
 assert.equal(frames.visible.evidence.frameCoverage.read,1);
 assert.equal(frames.hidden.evidence.forms.length,0);
 assert.equal(frames.denied.evidence.frameCoverage.unread,1);
 assert.equal(frames.ambiguous.evidence.forms.length,0);
 console.log('PASS: custom editors, body-only links, negative evidence and visible/hidden/unreadable iframe boundaries');
 const verdicts=await evaluate(`(async()=>{
   const read=readBlogPage,collect=collectCommentPages,request=discoveryRequest;
   let current;
   readBlogPage=async()=>({url:'https://blog.test/post',evidence:current,items:[]});
   collectCommentPages=async(id,page)=>page;
   // Deliberately optimistic model: local guard must reject insufficient evidence.
   discoveryRequest=async()=>({verdict:'likely_guest',reason:'Synthetic model result'});
   const cases=[
     {forms:[{comment:true,submit:true,website:false,bodyLinks:true,frameId:0}],notices:[]},
     {forms:[{comment:true,submit:true,website:false,bodyLinks:false}],notices:[]},
     {forms:[{comment:true,submit:true,bodyLinks:true,captcha:true}],notices:[]},
     {forms:[{comment:true,submit:true,bodyLinks:true}],notices:['Login to post']},
     {forms:[{comment:true,submit:true,website:true,frameId:9}],notices:[]},
     {forms:[{comment:true,submit:true,website:true,custom:true}],notices:[]},
     {forms:[{comment:true,submit:true,website:true,custom:false,frameId:0}],notices:[]},
   ];
   try{
     const result=[];
     for(const evidence of cases){current=evidence;result.push(await visitBlog('https://blog.test/post',()=>false));}
     return result;
   }finally{readBlogPage=read;collectCommentPages=collect;discoveryRequest=request;}
 })()`);
 assert.deepEqual(verdicts.map(v=>v.verdict),['likely_guest','link_unverified','unknown','unknown','likely_guest','likely_guest','likely_guest']);
 assert.equal(verdicts[0].manualFillRequired,true,'body-only candidates retained, not sent to unsupported autofill');
 assert.equal(verdicts[4].manualFillRequired,true,'iframe autofill needs manual handling');
 assert.equal(verdicts[5].manualFillRequired,true,'custom editor autofill needs manual handling');
 assert.equal(verdicts[6].manualFillRequired,false,'standard form autofill remains supported');
 console.log('PASS: full analysis pipeline rejects optimistic model mistakes and separates eligibility from autofill capability');
 const disabled=await evaluate(`(()=>{
   const frame=document.createElement('iframe');document.body.append(frame);const w=frame.contentWindow;
   w.document.body.innerHTML='<div id="comments"><form id="commentform"><textarea name="comment" required></textarea><button type="submit" disabled>Comentario</button><button type="button" aria-label="Enlace">🔗</button></form><iframe src="https://googleads.example.test/ad"></iframe><iframe name="comment-child" src="https://comments.test/widget"></iframe></div>';
   const page=w.eval('('+readBlogEvidence.toString()+')(true)');frame.remove();
   const e=page.evidence,f=e.forms[0];
   return {form:f,frames:page.frames,waiting:commentEligibility(e,'unknown'),optimistic:commentEligibility(e,'likely_guest'),
     filledDisabled:commentEligibility({...e,forms:[{...f,editorEmpty:false,emptyRequired:[]}]},'unknown'),
     captcha:commentEligibility({...e,forms:[{...f,captcha:true}]},'likely_guest'),
     login:commentEligibility(e,'login_required')};
 })()`);
 assert.equal(disabled.form.submit,false);assert.equal(disabled.form.submitPresent,true);assert.equal(disabled.form.submitDisabled,true);
 assert.equal(disabled.form.bodyLinks,true,'Spanish link toolbar recognized');
 assert.equal(disabled.waiting,'link_unverified');assert.equal(disabled.optimistic,'link_unverified');
 assert.equal(disabled.filledDisabled,'unknown');assert.equal(disabled.captcha,'unknown');assert.equal(disabled.login,'login_required');
 assert.equal(disabled.frames.length,1,'advertising frames excluded');
 const fallback=await evaluate(`(async()=>{
   const script=chrome.scripting.executeScript,nav=chrome.webNavigation;
   const base={forms:[],notices:[],linkMethods:[]};
   const top={url:'https://blog.test/post',frames:[{url:'https://comments.test/old',name:'comment-child'}],items:[],evidence:base};
   const child={url:'https://comments.test/new',frameName:'comment-child',frames:[],items:[],evidence:{...base,forms:[{comment:true,submit:true,bodyLinks:true}]}};
   try{
     chrome.webNavigation={getAllFrames:async()=>[{frameId:0},{frameId:8},{frameId:9}]};
     chrome.scripting.executeScript=async args=>{
       if(args.target.allFrames)throw Error('One child unavailable');
       if(args.target.frameIds[0]===9)throw Error('Denied');
       return [{frameId:args.target.frameIds[0],result:args.target.frameIds[0]===0?top:child}];
     };
     return await readBlogPage(1);
   }finally{chrome.scripting.executeScript=script;chrome.webNavigation=nav;}
 })()`);
 assert.equal(fallback.evidence.forms[0].frameId,8);assert.equal(fallback.evidence.frameCoverage.read,1);
 console.log('PASS: disabled versus absent submit, dynamic candidate guards, multilingual link toolbar, ad exclusion and per-frame permission fallback');
 const searchGuard=await evaluate(`(async()=>{
   const create=chrome.tabs.create,get=chrome.tabs.get,remove=chrome.tabs.remove,request=discoveryRequest;
   let opens=0,closes=0,models=0;
   chrome.tabs.create=async()=>{opens++;return{id:999};};
   chrome.tabs.get=async()=>({id:999,status:'complete',url:'https://nl.search.yahoo.com/mobile/s?p=SportsCenter'});
   chrome.tabs.remove=async()=>{closes++;};
   discoveryRequest=async()=>{models++;throw Error('Search results must not invoke a model');};
   try{
     const direct=await visitBlog('https://pe.search.yahoo.com/mobile/s?p=test',()=>false);
     const redirect=await visitBlog('https://ordinary-blog.test/post',()=>false);
     return {opens,closes,models,direct,redirect,normal:URLTools.searchResultReason('https://news.yahoo.com/article.html'),lookalike:URLTools.searchResultReason('https://search.yahoo.com.other.test/post')};
   }finally{chrome.tabs.create=create;chrome.tabs.get=get;chrome.tabs.remove=remove;discoveryRequest=request;}
 })()`);
 assert.equal(searchGuard.opens,1);assert.equal(searchGuard.closes,1);assert.equal(searchGuard.models,0);
 assert.equal(searchGuard.direct.excluded,true);assert.equal(searchGuard.redirect.excluded,true);
 assert.equal(searchGuard.normal,'');assert.equal(searchGuard.lookalike,'');
 await call('Page.reload');await new Promise(r=>setTimeout(r,1000));
 assert.equal(await evaluate(`scanJobs.filter(j=>j.state==='done').length`),2);
 assert.deepEqual(await evaluate(`scanJobs[0].topics`),['美食','生活']);
 if(process.env.BACKLINK_AUDIT_SNAPSHOT){
   const snapshot=JSON.parse(fs.readFileSync(process.env.BACKLINK_AUDIT_SNAPSHOT,'utf8'));
   const audit=await evaluate(`(()=>{
     const data=${JSON.stringify(snapshot)};ahrefsGroups.clear();for(const group of data.ahrefsBacklinkGroups)ahrefsGroups.set(group.target,group.links);
     scanJobs=data.blogScanJobs;libraryRecords.clear();libraryFilter='all';$('librarySource').value='sources';renderAhrefs();
     const sources={cards:document.querySelectorAll('.library-card').length,text:$('collectedCount').textContent,merged:[...document.querySelectorAll('.link-evidence summary')].some(el=>el.textContent.includes('191'))};
     $('librarySource').value='authors';renderAhrefs();const authors={cards:document.querySelectorAll('.library-card').length,text:$('collectedCount').textContent};
     $('librarySource').value='sources';renderAhrefs();return {sources,authors};
   })()`);
   assert(audit.sources.merged,'191 same-topic resources grouped without deleting URLs');
   assert.equal(audit.sources.cards,253);assert.equal(audit.authors.cards,712);
   console.log('PASS: actual user snapshot in isolated UI: '+JSON.stringify(audit));
 }
 const qualityUI=await evaluate(`(()=>{
   ahrefsGroups.clear();libraryRecords.clear();libraryFilter='all';$('librarySource').value='sources';$('spamFilter').value='all';
   ahrefsGroups.set('target.test',[{url:'https://quality.test/a'},{url:'https://quality.test/b'}]);
   scanJobs=[{url:'https://quality.test/a',state:'done',verdict:'likely_guest',hasCommentForm:true,quality:{version:1,level:'high',reason:'评论样本异常',signals:[{type:'unrelated_promotion',quote:'Unrelated promotional content'}]}},{url:'https://quality.test/b',state:'done',verdict:'likely_guest',hasCommentForm:true}];
   $('qualityFilter').value='high';renderAhrefs();
   const high=document.querySelectorAll('.library-card').length;
   const evidence=$('ahrefsGroups').textContent.includes('Unrelated promotional content');
   const eligibility=libraryInfo({url:'https://quality.test/a'}).state;
   $('qualityFilter').value='exclude';renderAhrefs();const excluded=document.querySelectorAll('.library-card').length;
   $('qualityFilter').value='unknown';renderAhrefs();const unknown=document.querySelectorAll('.library-card').length;
   $('qualityFilter').value='all';renderAhrefs();
   return {high,evidence,eligibility,excluded,unknown};
 })()`);
 assert.deepEqual(qualityUI,{high:1,evidence:true,eligibility:'ready',excluded:1,unknown:1});
 const topicUI=await evaluate(`(async()=>{
   scanJobs[0].topics=['新闻'];scanJobs[1].topics=['美食','生活'];
   $('topicFilter').value='美食';$('topicFilter').dispatchEvent(new Event('change'));
   const food=document.querySelectorAll('.library-card').length;
   const text=$('ahrefsGroups').textContent;
   const saved=localStorage.getItem('resourceTopicFilter');
   $('topicFilter').value='新闻';renderAhrefs();
   const news=document.querySelectorAll('.library-card').length;
   $('qualityFilter').value='exclude';renderAhrefs();const combined=document.querySelectorAll('.library-card').length;
   $('qualityFilter').value='all';
   const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;let blob;
   URL.createObjectURL=value=>{blob=value;return 'blob:test';};HTMLAnchorElement.prototype.click=function(){};
   let csv,json;
   try{$('exportCSV').onclick();csv=await blob.text();$('exportAhrefs').onclick();json=JSON.parse(await blob.text());}
   finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;}
   $('topicFilter').value='unknown';renderAhrefs();const unknown=document.querySelectorAll('.library-card').length;
   $('topicFilter').value='新闻';renderAhrefs();
   return {food,text,saved,news,combined,unknown,csv,json};
 })()`);
 assert.equal(topicUI.food,1);assert(topicUI.text.includes('美食 · 生活'));
 assert.equal(topicUI.saved,'美食');assert.equal(topicUI.news,1);assert.equal(topicUI.combined,0);assert.equal(topicUI.unknown,0);
 assert(topicUI.csv.includes('主题标签'));assert(topicUI.csv.includes('新闻'));assert(!topicUI.csv.includes('quality.test/b'));
 assert.equal(topicUI.json.items.length,1);assert.deepEqual(topicUI.json.items[0].blogAssessment.topics,['新闻']);
 console.log('PASS: topic persistence, multi-label display, intersection filters and CSV/JSON exports');
 const qualityPublish=await evaluate(`(async()=>{$('publishDomain').value='my-real-site.test';$('publisherName').value='Test Owner';$('publisherEmail').value='owner@my-real-site.test';window.publishedCalls=[];automation.openAuthorized=async url=>{window.publishedCalls.push(url);};await publishLibrary();return window.publishedCalls;})()`);
 assert.deepEqual(qualityPublish,['https://quality.test/b'],'topic-filtered news does not block eligible food page; high-risk page remains excluded');
 console.log('PASS: independent quality filter, evidence rendering, unknown legacy resources and preserved eligibility');
 if(process.env.BACKLINK_UI_PREVIEW){
   const dir=process.env.BACKLINK_UI_PREVIEW;fs.mkdirSync(dir,{recursive:true});
   for(const width of [360,1000]){
     await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
     for(const pane of ['collectPane','publishPane','libraryPane','settings']){
       await evaluate(`(()=>{if($('settings').open)$('settings').close();$('topicFilter').value='all';renderAhrefs();showPane('${pane==='settings'?'collectPane':pane}');if('${pane}'==='libraryPane')document.querySelector('.spam-options').open=true;if('${pane}'==='settings')$('settings').showModal();window.scrollTo(0,0);})()`);
       const fit=await evaluate(`({body:document.documentElement.scrollWidth,viewport:innerWidth,dialog:$('settings').scrollWidth,dialogWidth:$('settings').clientWidth})`);
       assert(fit.body<=fit.viewport,JSON.stringify({pane,width,fit}));
       if(pane==='settings')assert(fit.dialog<=fit.dialogWidth,JSON.stringify(fit));
       const preview=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,pane+'-'+width+'.png'),Buffer.from(preview.data,'base64'));
     }
   }
   console.log('PASS: collect/publish/library/settings fit narrow and wide viewports; previews saved');
 }
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log('PASS: DOM initialization, auto analysis, recursion, filters, persistence, batch stop on unknown and duplicate prevention');console.log(shotPath);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{ws?.close();chrome?.kill();server.close();});
