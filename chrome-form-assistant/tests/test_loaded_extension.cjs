// Actual unpacked extension, real Chrome tabs/scripting/permissions, synthetic local web forms/model.
const {chromium}=require('../../outreach/node_modules/playwright-core');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http'),zlib=require('node:zlib');
const executable='/Users/am/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const KEY='SYNTHETIC-LOADED-EXTENSION-KEY';
const profile={llm:{base_url:'https://cubapi.codemao.cn/v1',api_key:KEY,model:'gpt-5.6-sol',reasoning_effort:'low',wire_api:'responses'},kits:[{product:{name:'Loaded extension test',url:'https://loaded-product.example/',submitter:{name:'Test Owner',email:'test@example.com'}}}],ledger:[]};
const comment=(name='commentform')=>`<form id="${name}"><label>Name<input name="author"></label><label>Email<input type="email"></label><label>Website<input type="url"></label><label>Comment<textarea></textarea></label><button type="submit">Post comment</button></form>`;
(async()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'form-assistant-v05-')),extension=path.join(temporary,'extension'),userData=path.join(temporary,'profile');let context;
 let submissions=0;
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://fixture').pathname;
  if(pathname==='/redirect'){res.writeHead(302,{Location:`http://localhost:${server.address().port}/final`});return res.end();}
  if(req.method!=='GET'){submissions++;res.writeHead(200);return res.end('submitted');}
  let title=pathname==='/cancel'?'Cancel':'Research citations';let forms=comment();
  if(pathname==='/ambiguous')forms=comment('comment1')+comment('comment2');
  if(pathname==='/captcha')forms=comment().replace('</form>','<div class="g-recaptcha" data-sitekey="synthetic"></div></form>');
  if(pathname==='/contact')forms='<form id="contact"><label>Name<input></label><label>Message<textarea></textarea></label><button>Contact</button></form>';
  if(pathname==='/directory')forms='<form><label>Product name<input></label><label>Website<input type="url"></label><label>Description<textarea></textarea></label><button>Send</button></form>';
  if(pathname==='/dynamic')forms=`<div id="mount"></div><script>setTimeout(()=>document.querySelector('#mount').innerHTML=${JSON.stringify(comment())},600)</script>`;
  res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><html lang="en"><title>${title}</title><article><h1>Research needs transparent citations</h1><p>Compare primary sources and inspect citations before choosing research tools.</p>${forms}</article><script>document.addEventListener('submit',e=>{e.preventDefault();window.submitted=(window.submitted||0)+1})</script></html>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  fs.cpSync(path.resolve(__dirname,'../extension'),extension,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));
  // Test-only pregrant: APIs remain real; native optional-permission dialog is not automated.
  manifest.host_permissions.push('http://127.0.0.1/*','http://localhost/*');fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const launch=()=>chromium.launchPersistentContext(userData,{executablePath:executable,headless:true,viewport:{width:390,height:844},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  context=await launch();let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');let panel=await context.newPage();const panelURL=new URL('sidepanel.html',worker.url()).href;
  const modelRequests=[];let delayCancel=false;
  await context.route('https://cubapi.codemao.cn/**',async route=>{
   const req=route.request();if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'}});
   const body=req.postDataJSON();modelRequests.push(body);assert.equal(req.headers().authorization,'Bearer '+KEY);assert.equal(body.store,false);assert.equal(body.stream,false);assert.equal(body.reasoning.effort,'low');assert(!JSON.stringify(body).includes(KEY));
   const data=JSON.parse(body.input[0].content.split('\n').slice(1).join('\n'));
   if(data.page?.title==='Cancel'&&delayCancel)await new Promise(resolve=>setTimeout(resolve,900));
   const output=data.test?{ok:true}:{values:data.fields.map(field=>({id:field.id,value:'Transparent citations help readers evaluate primary sources.'}))};
   await route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(output)}]}]})}).catch(()=>{});
  });
  await panel.goto(panelURL);await panel.evaluate(()=>document.getElementById('autoSubmit').checked=false);await panel.locator('#status').filter({hasText:'尚未配置模型 API Key'}).waitFor();assert((await panel.locator('#product option').count())>0,'empty database must seed product');assert((await panel.locator('#sourceInfo').innerText()).includes('选择 JSON'));assert.equal(await panel.locator('#settings').evaluate(el=>el.open),false);await panel.screenshot({path:'/tmp/form-assistant-v05-empty.png',fullPage:true});
  // Full external snapshot, not packaged. Search one detail-only URL.
  const aggregatePath=path.resolve(__dirname,'../local-resources/backlinks.json.gz');
  await panel.locator('#resourceFile').setInputFiles(aggregatePath);await panel.locator('#status').filter({hasText:'本地文件已导入'}).waitFor();assert.equal((await panel.evaluate(()=>LocalAPI.resourceSource())).metadata.uniqueURLs,181878);
  const aggregate=JSON.parse(zlib.gunzipSync(fs.readFileSync(aggregatePath)));
  const detail=aggregate.rows.find(row=>row[0].length<150&&row[6].every(id=>aggregate.sources[id].startsWith('links/')));
  await panel.locator('#resourceQuery').fill(detail[0]);await panel.locator('#resourceQuery').press('Enter');await panel.locator('.resource a').filter({hasText:detail[0]}).first().waitFor();
  const countBefore=context.pages().length;await panel.locator('.resource button').first().click();await panel.locator('#status').filter({hasText:'尚未配置模型 API Key'}).waitFor();assert.equal(context.pages().length,countBefore);
  await panel.locator('#onboard').click();await panel.locator('summary').filter({hasText:'导入产品资料与模型配置'}).click();await panel.locator('#profileFile').setInputFiles({name:'synthetic-profile.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(profile))});await panel.locator('#status').filter({hasText:'文件检查通过'}).waitFor();await panel.locator('#applyProfile').click();await panel.locator('#status').filter({hasText:'已导入 1 个产品'}).waitFor();await panel.locator('#closeSettings').click();await panel.locator('#product').selectOption({label:'Loaded extension test'});await panel.locator('#status').filter({hasText:'产品已切换'}).waitFor();
  // Current-page action reuses its active tab and preserves browser URL, including tracking/hash.
  const currentPage=await context.newPage();await currentPage.goto(base+'/current?utm_source=fixture#comment');await currentPage.bringToFront();const pagesBefore=context.pages().length;await panel.locator('#fillCurrent').click();await panel.locator('#status').filter({hasText:'已记录为已填写'}).waitFor();await panel.locator('#cancelAuto').waitFor({state:'hidden'});assert.equal(context.pages().length,pagesBefore);assert.notEqual(await currentPage.locator('textarea').inputValue(),'');assert.equal(currentPage.url(),base+'/current?utm_source=fixture#comment');
  const urls=['/post','/ambiguous','/cancel','/race','/redirect','/dynamic','/中文','/a/../dot','/captcha','/contact','/directory'];
  const fixtures={items:urls.map(url=>({url:base+url,title:url,platform:'blog'}))};
  await panel.locator('#resourceQuery').fill('');await panel.locator('#resourceFile').setInputFiles({name:'local-fixtures.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixtures))});await panel.locator('#status').filter({hasText:'本地文件已导入'}).waitFor();
  async function find(url){await panel.locator('#resourceQuery').fill(url);await panel.locator('#resourceQuery').press('Enter');await panel.locator('#resourceCount').filter({hasText:'1 条'}).waitFor();}
  async function open(url){await find(url);const created=context.waitForEvent('page');await panel.locator('.resource button').first().click();const page=await created;return page;}
  async function complete(){await panel.locator('#status').filter({hasText:'已记录为已填写'}).waitFor();await panel.locator('#cancelAuto').waitFor({state:'hidden'});}
  const post=await open(base+'/post');await complete();assert.equal(await post.locator('textarea').inputValue(),'Transparent citations help readers evaluate primary sources.');assert.equal(await post.evaluate(()=>window.submitted||0),0);assert(!(await post.content()).includes(KEY));
  await panel.locator('#tracking summary').click();await panel.locator('#confirmed').check();await panel.locator('#markSubmitted').click();await panel.locator('.resource').filter({hasText:'用户确认已提交'}).waitFor();
  const ambiguous=await open(base+'/ambiguous');await panel.locator('#status').filter({hasText:'找到多个匹配表单'}).waitFor();assert.equal(await ambiguous.locator('textarea').first().inputValue(),'');await panel.locator('#form').selectOption({index:1});await panel.locator('#resumeAuto').click();await complete();assert.equal(await ambiguous.locator('textarea').first().inputValue(),'');assert.notEqual(await ambiguous.locator('textarea').nth(1).inputValue(),'');
  // Undo remains bound to the shown target even after the user activates another filled tab.
  await post.bringToFront();await panel.locator('#undo').click();await panel.locator('#status').filter({hasText:'已撤销'}).waitFor();assert.equal(await ambiguous.locator('textarea').nth(1).inputValue(),'');assert.notEqual(await post.locator('textarea').inputValue(),'');
  delayCancel=true;const canceled=await open(base+'/cancel');await panel.locator('#status').filter({hasText:'正在生成草稿'}).waitFor();await panel.locator('#cancelAuto').click();const race=await open(base+'/race');await complete();await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(await canceled.locator('textarea').inputValue(),'');assert.notEqual(await race.locator('textarea').inputValue(),'');assert((await panel.locator('#targetState').innerText()).includes('/race'));
  const redirected=await open(base+'/redirect');await panel.locator('#status').filter({hasText:'目标已跳转'}).waitFor();await redirected.waitForURL('http://localhost:'+server.address().port+'/final');assert.equal(await redirected.locator('textarea').inputValue(),'');await panel.locator('#resumeAuto').click();await complete();assert.notEqual(await redirected.locator('textarea').inputValue(),'');assert((await panel.locator('#targetState').innerText()).includes(base+'/redirect'));
  const dynamic=await open(base+'/dynamic');await complete();assert.notEqual(await dynamic.locator('textarea').inputValue(),'');
  const unicode=await open(base+'/中文');await complete();assert.notEqual(await unicode.locator('textarea').inputValue(),'');assert((await panel.locator('.resource').innerText()).includes('已填写（未提交）'));
  const dot=await open(base+'/a/../dot');await complete();assert.notEqual(await dot.locator('textarea').inputValue(),'');
  await open(base+'/captcha');await panel.locator('#status').filter({hasText:'页面包含验证码'}).waitFor();
  await open(base+'/contact');await panel.locator('#status').filter({hasText:'没有找到明确'}).waitFor();
  await panel.locator('#mode').selectOption('directory');const directory=await open(base+'/directory');await complete();assert.notEqual(await directory.locator('textarea').inputValue(),'');
  // Atomic wrong-file rejection keeps the existing selected source.
  await panel.locator('#resourceFile').setInputFiles({name:'wrong-model-profile.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(profile))});await panel.locator('#status').filter({hasText:'不支持该资源文件结构'}).waitFor();assert.equal((await panel.evaluate(()=>LocalAPI.resourceSource())).name,'local-fixtures.json');
  // Quoted CSV/BOM and TXT; old ledger targets must not be appended to a chosen file.
  await panel.locator('#resourceFile').setInputFiles({name:'quoted.csv',mimeType:'text/csv',buffer:Buffer.from('\uFEFFSource URL,title\r\n"'+base+'/csv","A comma, and ""quote"""\r\n')});await panel.locator('#status').filter({hasText:'本地文件已导入'}).waitFor();await panel.locator('#resourceQuery').fill('');await panel.locator('#resourceQuery').press('Enter');await panel.locator('#resourceCount').filter({hasText:'1 条'}).waitFor();assert((await panel.locator('.resource').innerText()).includes('A comma, and "quote"'));
  await panel.locator('#resourceFile').setInputFiles({name:'small.txt',mimeType:'text/plain',buffer:Buffer.from(base+'/text\nhttps://unsafe.test/?token=secret\n')});await panel.locator('#status').filter({hasText:'本地文件已导入'}).waitFor();assert.equal((await panel.evaluate(()=>LocalAPI.resourceSource())).metadata.rejectedRows,1);
  // Real OPFS handle storage/refresh; only the native chooser is stubbed for headless automation.
  await panel.evaluate(async base=>{const dir=await navigator.storage.getDirectory();const handle=await dir.getFileHandle('linked.json',{create:true});const out=await handle.createWritable();await out.write(JSON.stringify([{url:base+'/linked-one'}]));await out.close();window.fixtureHandle=handle;window.showOpenFilePicker=async()=>[handle];},base);
  await panel.locator('#onboard').click();await panel.locator('summary').filter({hasText:'文件与填写选项'}).click();await panel.locator('#linkFile').click();await panel.locator('#status').filter({hasText:'已关联原文件'}).waitFor();assert.equal((await panel.evaluate(()=>LocalAPI.resourceSource())).linked,true);
  await panel.evaluate(async base=>{const out=await window.fixtureHandle.createWritable();await out.write(JSON.stringify([{url:base+'/linked-two'},{url:base+'/linked-three'}]));await out.close();},base);
  await panel.locator('#refreshFile').click();await panel.locator('#status').filter({hasText:'已刷新关联文件'}).waitFor();assert.equal((await panel.evaluate(()=>LocalAPI.resourceSource())).metadata.uniqueURLs,2);
  await panel.screenshot({path:'/tmp/form-assistant-v05-settings.png',fullPage:true});await panel.locator('#closeSettings').click();await panel.screenshot({path:'/tmp/form-assistant-v05.png',fullPage:true});
  assert.equal(submissions,0);assert(modelRequests.length>0);
  await context.close();context=null;context=await launch();worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');panel=await context.newPage();await panel.goto(new URL('sidepanel.html',worker.url()).href);await panel.locator('#status').filter({hasText:'已就绪'}).waitFor();assert.equal((await panel.evaluate(()=>LocalAPI.resourceSource())).name,'linked.json');assert.equal((await panel.evaluate(()=>LocalAPI.resourceSource())).metadata.uniqueURLs,2);assert.equal((await panel.evaluate(()=>LocalAPI.configView())).hasKey,true);assert.equal(await panel.locator('#apiKey').inputValue(),'');
  console.log('Actual extension v0.5 passed: seeded product/no-key prompt, external 181878 URL import/detail search, real HTTP tabs/permissions/scripting autofill, manual submission boundary, ambiguity, cancel/restart, redirect pause, dynamic/Unicode/dot paths, CAPTCHA/contact stop, directory heuristic, atomic JSON/CSV/TXT/GZ imports, OPFS linked refresh and restart persistence. Screenshot /tmp/form-assistant-v05.png');
 }finally{if(context)await context.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
