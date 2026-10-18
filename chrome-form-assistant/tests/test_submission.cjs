// Real unpacked extension and synthetic local forms only; no external submissions.
const {chromium}=require('../../outreach/node_modules/playwright-core');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const executable='/Users/am/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'submit-test-'));let context;const counts={};
 const body='The article explains why checking original sources helps readers assess evidence.';
 const form='<form id="commentform" method="post"><label>Name<input name="author"></label><label>Email<input name="email" type="email"></label><label>Website<input name="url" type="url"></label><label>Comment<textarea name="comment" required></textarea></label><button type="submit">Post Comment</button></form>';
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');res.setHeader('Content-Type','text/html');
  if(req.method==='POST'){counts[url.pathname]=(counts[url.pathname]||0)+1;req.resume();return res.end('<html><title>Result</title>'+ (url.pathname==='/pending'?'<p class="comment-awaiting-moderation">Your comment is awaiting moderation.</p>':url.pathname==='/unknown'?'<p>Thanks</p>':`<article class="comment" id="div-comment-new">${body}</article>`)+'</html>');}
  res.end('<html><title>Original sources</title><article><p>Always inspect original sources to understand claims.</p></article>'+form+'</html>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const dir=path.join(tmp,'extension');fs.cpSync(path.resolve(__dirname,'../extension'),dir,{recursive:true});const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));manifest.host_permissions.push('http://127.0.0.1/*');fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(path.join(tmp,'profile'),{executablePath:executable,headless:true,args:['--disable-extensions-except='+dir,'--load-extension='+dir]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const panel=await context.newPage();
  await context.route('https://cubapi.codemao.cn/**',route=>{const data=JSON.parse(route.request().postDataJSON().input[0].content.split('\n').slice(1).join('\n'));return route.fulfill({contentType:'application/json',body:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({values:data.fields.map(f=>({id:f.id,value:body}))})}]}]})});});
  await panel.goto(new URL('sidepanel.html',worker.url()).href);
  await panel.evaluate(async()=>{await LocalAPI.init();await LocalAPI.importProfile({llm:{base_url:'https://cubapi.codemao.cn/v1',api_key:'TEST-ONLY',model:'gpt-5.6-sol',wire_api:'responses',reasoning_effort:'low'},kits:[{product:{name:'Submission Test',url:'https://submission-test.example/',submitter:{name:'Owner',email:'owner@example.com'}}}]});await products();await displayConfig();});
  async function run(route,state){await panel.evaluate(url=>automation.open(url),base+route);await panel.waitForFunction(s=>target?.workflow.state===s&&!autoActive,state,{timeout:25000});assert.equal(counts[route],1);return context.pages().find(p=>p.url()===base+route);}
  await run('/published','published');await run('/pending','pending_review');await run('/unknown','outcome_unknown');
  await panel.evaluate(url=>automation.open(url),base+'/unknown');await panel.locator('#status').filter({hasText:'禁止重复'}).waitFor();assert.equal(counts['/unknown'],1);
  // Atomic claims across concurrent clients; imports and undo cannot remove a lock.
  const id=await panel.evaluate(()=>$('product').value);
  const locks=await panel.evaluate(async({id,url})=>{const results=await Promise.allSettled(['a','b'].map(attemptId=>LocalAPI.api('/record',{productId:id,url,action:'attempt',attemptId})));await LocalAPI.api('/record',{productId:id,url,action:'undo'});return {fulfilled:results.filter(r=>r.status==='fulfilled').length,state:(await LocalAPI.api('/resource',{productId:id,url})).workflow.state};},{id,url:base+'/race'});assert.deepEqual(locks,{fulfilled:1,state:'outcome_unknown'});
  // Reload extension UI: unknown still blocked and cannot be automatically retried.
  await panel.reload();await panel.evaluate(async()=>{await LocalAPI.init();});assert.equal(await panel.evaluate(async({id,url})=>(await LocalAPI.api('/resource',{productId:id,url})).workflow.state,{id,url:base+'/unknown'}),'outcome_unknown');
  // Content boundary: fresh CAPTCHA, login, stale values and double-click replay.
  const page=await context.newPage();await page.goto(base+'/guards');
  const send=(kind,payload)=>panel.evaluate(async({tabURL,kind,payload})=>{const tabs=await chrome.tabs.query({});const t=tabs.find(t=>t.url===tabURL);await chrome.scripting.executeScript({target:{tabId:t.id},files:['content.js']});return chrome.tabs.sendMessage(t.id,{kind,payload});},{tabURL:page.url(),kind,payload});
  const snap=(await send('analyze')).data;const group=snap.groups[0];const payload={documentId:snap.documentId,snapshotId:snap.snapshotId,formId:group.id,mode:'blog'};
  await send('fill',{...payload,values:[{id:group.fields.find(f=>f.type==='textarea').id,value:body}]});
  let prep=(await send('prepareSubmit',payload)).data;assert(prep);
  await page.evaluate(()=>{const el=document.createElement('div');el.className='cf-turnstile';document.body.append(el);});assert.equal((await send('submit',{...payload,ticket:prep.ticket})).data.paused,true);assert(!counts['/guards']);
  await page.locator('.cf-turnstile').evaluate(el=>el.remove());
  await page.evaluate(()=>{const el=document.createElement('input');el.type='password';document.body.append(el);});assert.equal((await send('prepareSubmit',payload)).ok,false);await page.locator('input[type=password]').evaluate(el=>el.remove());
  prep=(await send('prepareSubmit',payload)).data;await page.locator('textarea').fill(body+' Edited');assert.equal((await send('submit',{...payload,ticket:prep.ticket})).data.paused,true);
  await page.locator('textarea').fill(body);await page.evaluate(text=>{const el=document.createElement('div');el.className='comment-body';el.textContent=text;document.body.append(el);},body);assert.equal((await send('prepareSubmit',payload)).ok,false);await page.locator('.comment-body').evaluate(el=>el.remove());
  // A matching string inside an editor is not public evidence; generic thanks is unknown.
  assert.equal((await send('submissionResult',prep.probe)).data.state,'outcome_unknown');
  await page.evaluate(()=>document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.clicks=(window.clicks||0)+1;}));
  prep=(await send('prepareSubmit',payload)).data;assert.equal((await send('submit',{...payload,ticket:prep.ticket})).data.clicked,true);assert.equal((await send('submit',{...payload,ticket:prep.ticket})).data.paused,true);assert.equal(await page.evaluate(()=>window.clicks),1);
  await page.evaluate(()=>{const el=document.createElement('div');el.setAttribute('role','alert');el.textContent='Your listing has been received for review';document.body.append(el);});
  assert.equal((await send('submissionResult',{...prep.probe,mode:'directory'})).data.state,'pending_review');
  await page.locator('[role=alert]').evaluate(el=>el.textContent='Duplicate comment detected');
  assert.equal((await send('submissionResult',prep.probe)).data.state,'submit_failed');
  await page.locator('[role=alert]').evaluate(el=>el.textContent='ERROR: required field is missing');
  assert.equal((await send('submissionResult',prep.probe)).data.state,'submit_failed');
  await panel.screenshot({path:'/tmp/form-assistant-v06.png',fullPage:true});
  console.log('PASS: actual POST/navigation + published/pending/unknown, durable lock/reload, concurrent claims, CAPTCHA/login pauses, edits, existing comments, editor false positives, one-shot ticket.');
 }finally{await context?.close();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
