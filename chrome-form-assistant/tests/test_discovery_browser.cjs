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
 discoveryRequest=async(path,data)=>(data.test||path==='health')?{ok:true,capacity:5}:{verdict:'likely_guest',reason:'Enabled guest comment form'};
 collectSemrush=async domain=>({target:domain,rows:[{url:'https://child.test/post',title:'Child blog'}]});
 await saveCollected('target.test',[{url:'https://blog.test/post',title:'Blog article'}]);
 $('recursionRounds').value='1';await afterCollection([{url:'https://blog.test/post'}]);
 })()`);
 const result=await evaluate(`({jobs:scanJobs, tasks:JSON.parse(localStorage.getItem('test:'+recursionKey)), comments:JSON.parse(localStorage.getItem('test:'+blogKey))})`);
 assert.equal(result.jobs.length,2);assert(result.jobs.every(j=>j.state==='done'));
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
   const reportLocation={hostname:'sem.3ue.co',pathname:'/analytics/backlinks/backlinks/',origin:'https://sem.3ue.co',href:'https://sem.3ue.co/analytics/backlinks/backlinks/?q=target.test'};
   const reportAction=win.Function('location','return ('+advanceCollection.toString()+')("semrush")')(reportLocation);
   const result={methods:page.evidence.linkMethods,links:page.items[0].links,expanded:win.didExpand,action,response,reportAction,didNext:win.didNext,badSubmit:!!win.badSubmit};frame.remove();return result;
 })()`);
 assert(evidence.methods.includes('website_field'));assert(evidence.methods.includes('existing_body_links'));
 assert.equal(evidence.expanded,true);assert.equal(evidence.action.kind,'expand');
 assert.deepEqual(evidence.links[0].rel,['ugc','nofollow']);
 assert.equal(evidence.response.data.linkCheck.found,true);assert.deepEqual(evidence.response.data.linkCheck.links[0].rel,['ugc','nofollow']);
 assert.equal(evidence.reportAction.advanced,true);assert.equal(evidence.didNext,true);assert.equal(evidence.badSubmit,false);
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
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log('PASS: DOM initialization, auto analysis, recursion, filters, persistence, batch stop on unknown and duplicate prevention');console.log(shotPath);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{ws?.close();chrome?.kill();server.close();});
