// Real LocalAPI + IndexedDB, mocked Chrome only for activeTab and local fixture injection.
const {chromium} = require('../../outreach/node_modules/playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const root=path.join(__dirname,'../extension');
const KEY='SYNTHETIC-BROWSER-KEY-DO-NOT-USE';
const profile={llm:{base_url:'https://cubapi.codemao.cn/v1',api_key:KEY,model:'gpt-5.6-sol',wire_api:'responses',reasoning_effort:'low'},kits:[0,1].map(i=>({product:{name:'Test Product '+i,url:`https://product${i}.example/`,submitter:{name:'Test Owner',email:'test@example.com'}},copy:{taglines:['Honest synthetic product']},compliance:{forbidden_claims_regex:['guaranteed']}})),ledger:[]};
const historical={url:'http://resource.test/post',domain:'resource.test',title:'A historical source',type:'historical_blog',platform:'blog',status:'live',observedAt:'2026-08-29',sources:[{file:'verified_blog_comments.json'}]};
const catalog={items:[historical,...Array.from({length:13},(_,i)=>({url:`http://candidate${i}.test/`,domain:`candidate${i}.test`,title:'Candidate '+i,type:'candidate',platform:'cms',status:'unverified',observedAt:'2026-08-01',sources:[{file:'library.json'}]}))]};
(async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}}),target=await context.newPage();
  let grant=true,created=0,accessRestricted=false,providerError=false,denySite=false;const storage={},permissions=new Set(['https://cubapi.codemao.cn/*']),requests=[],calls=[],consoleText=[];
  await target.route('**/*',route=>route.fulfill({body:fs.readFileSync(path.join(__dirname,'fixtures/blog.html')),contentType:'text/html'}));await target.goto('http://resource.test/post');
  const panel=await context.newPage();panel.on('console',msg=>consoleText.push(msg.text()));panel.on('pageerror',error=>consoleText.push(error.message));panel.on('request',request=>requests.push(request.url()));
  await panel.exposeFunction('mockGet',()=>({id:7,url:target.url(),status:'complete'}));
  await panel.exposeFunction('mockCurrent',()=>[{id:7,...(grant?{url:target.url()}:{})}]);
  await panel.exposeFunction('mockInject',async()=>{if(!grant)throw Error('activeTab permission required');await target.evaluate(()=>{window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.listener=fn;}}}};});await target.evaluate(fs.readFileSync(path.join(root,'content.js'),'utf8'));});
  await panel.exposeFunction('mockMessage',async(id,message)=>{assert(!JSON.stringify(message).includes(KEY));return target.evaluate(({message})=>new Promise(resolve=>window.listener(message,{id:'test'},resolve)),{message});});
  await panel.exposeFunction('mockCreate',async({url})=>{created++;grant=false;await target.goto(url);return{id:7};});
  await panel.exposeFunction('mockStorageAccess',async options=>{assert.equal(options.accessLevel,'TRUSTED_CONTEXTS');accessRestricted=true;});
  await panel.exposeFunction('mockStorageGet',async key=>{assert(accessRestricted);return{[key]:storage[key]};});
  await panel.exposeFunction('mockStorageSet',async value=>{assert(accessRestricted);assert(!JSON.stringify(value).includes(KEY));Object.assign(storage,value);});
  await panel.exposeFunction('mockPermissionContains',({origins})=>origins.every(origin=>permissions.has(origin)));
  await panel.exposeFunction('mockPermissionRequest',({origins=[],permissions:requested=[]})=>{assert.equal(requested.length,0,'site access must not request browsing metadata');if(denySite&&origins.some(origin=>/^https?:\/\/resource\.test\/\*$/.test(origin)))return false;for(const origin of origins)permissions.add(origin);return true;});
  await panel.addInitScript(()=>{window.chrome={runtime:{getURL:file=>'https://panel.test/'+file},storage:{local:{setAccessLevel:options=>window.mockStorageAccess(options),get:key=>window.mockStorageGet(key),set:value=>window.mockStorageSet(value)}},permissions:{contains:options=>window.mockPermissionContains(options),request:options=>window.mockPermissionRequest(options)},tabs:{get:id=>window.mockGet(id),onUpdated:{addListener(){},removeListener(){}},query:()=>window.mockCurrent(),sendMessage:(id,message)=>window.mockMessage(id,message),create:options=>window.mockCreate(options)},scripting:{executeScript:()=>window.mockInject()}};});
  await panel.route('https://panel.test/**',route=>{const file=new URL(route.request().url()).pathname.slice(1)||'sidepanel.html';if(file==='products.json')return route.fulfill({body:JSON.stringify({kits:[profile.kits[0]]}),contentType:'application/json'});return route.fulfill({body:fs.readFileSync(path.join(root,file)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});});
  await panel.route('https://cubapi.codemao.cn/**',async route=>{
   const req=route.request();if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'}});
   const body=req.postDataJSON();calls.push(body);assert.equal(req.headers().authorization,'Bearer '+KEY);assert(!JSON.stringify(body).includes(KEY));assert.equal(body.model,'gpt-5.6-sol');assert.equal(body.reasoning.effort,'low');assert.equal(body.store,false);assert.equal(body.stream,false);assert.equal(body.text.format.type,'json_object');assert(!('temperature'in body));
   if(providerError)return route.fulfill({status:500,body:JSON.stringify({error:KEY+' provider private detail'}),contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'}});
   const input=body.input[0].content;assert(input.includes('JSON'));
   const data=JSON.parse(input.slice(input.indexOf('\n')+1));
   const result=data.test?{ok:true}:{values:data.fields.map(f=>({id:f.id,value:'Transparent citations make research easier to evaluate.'}))};
   return route.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(result)}]}]})});
  });
  await panel.goto('https://panel.test/sidepanel.html');await panel.locator('#status').filter({hasText:'尚未配置模型 API Key'}).waitFor();
  await panel.locator('#resourceFile').setInputFiles({name:'synthetic-resources.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(catalog))});await panel.locator('#status').filter({hasText:'本地文件已导入'}).waitFor();
  const before=created;await panel.locator('.resource button').first().click();await panel.locator('#status').filter({hasText:'尚未配置模型 API Key'}).waitFor();assert.equal(created,before,'missing key must not open target');
  await panel.locator('#onboard').click();await panel.locator('summary').filter({hasText:'导入产品资料与模型配置'}).click();await panel.locator('#profileFile').setInputFiles({name:'synthetic-profile.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(profile))});await panel.locator('#status').filter({hasText:'文件检查通过'}).waitFor();await panel.locator('#applyProfile').click();await panel.locator('#status').filter({hasText:'已导入 2 个产品'}).waitFor();
  assert.equal(await panel.locator('#apiKey').inputValue(),'');assert((await panel.locator('#keyState').innerText()).includes('已保存'));assert.equal(calls.length,0,'import must not invoke model');
  await panel.locator('#testConnection').click();await panel.locator('#status').filter({hasText:'模型连接成功'}).waitFor();await panel.locator('#closeSettings').click();
  assert.equal(await panel.locator('.resource').count(),10);await panel.locator('#resourceNext').click();await panel.locator('#resourceCount').filter({hasText:'第 2 页'}).waitFor();assert.equal(await panel.locator('.resource').count(),4);
  await panel.locator('#resourceQuery').fill('resource.test');await panel.locator('#resourceQuery').press('Enter');await panel.locator('#resourceCount').filter({hasText:'1 条'}).waitFor();denySite=true;await panel.locator('.resource button').first().click();await panel.locator('#status').filter({hasText:'未授权此网站'}).waitFor();assert.equal(created,0);denySite=false;await panel.locator('.resource a').click();await panel.locator('#status').filter({hasText:'目标已打开'}).waitFor();assert.equal(created,1);
  await panel.evaluate(()=>document.getElementById('autoSubmit').checked=false);await panel.locator('#fillCurrent').click();await panel.locator('#status').filter({hasText:'点击插件图标'}).waitFor();grant=true;await target.goto('http://resource.test/post?utm_source=fixture#comment');await panel.evaluate(()=>document.getElementById('autoSubmit').checked=false);await panel.locator('#fillCurrent').click();await panel.locator('#targetState').filter({hasText:'已填写（未提交）'}).waitFor();assert.equal(await target.locator('textarea').inputValue(),'Transparent citations make research easier to evaluate.');assert.equal(created,1,'current page must reuse the existing tab');
  assert(!JSON.stringify(await target.evaluate(()=>({html:document.documentElement.outerHTML,globals:Object.keys(window)}))).includes(KEY));
  await target.goto('http://resource.test/thanks');grant=false;await panel.locator('#tracking summary').click();await panel.locator('#confirmed').check();await panel.locator('#markSubmitted').click();await panel.locator('.resource').filter({hasText:'用户确认已提交'}).waitFor();assert((await panel.locator('#targetState').innerText()).includes('/post'));assert(!(await panel.locator('#targetState').innerText()).includes('/thanks'));assert.equal(await panel.evaluate(()=>target.workflow.state),'submitted');
  await panel.screenshot({path:'/tmp/form-assistant-v05-manual.png',fullPage:true});
  const ids=await panel.locator('#product').evaluate(select=>[select.value,...[...select.options].map(n=>n.value).filter(value=>value!==select.value)]);
  await panel.locator('#product').selectOption(ids[1]);await panel.locator('#status').filter({hasText:'产品已切换'}).waitFor();assert.equal(await panel.locator('#confirmed').isChecked(),false);await target.goto('http://resource.test/post');grant=true;await panel.evaluate(()=>run(async()=>{await analyzePage(await current());}));await panel.locator('#status').filter({hasText:'分析完成'}).waitFor();assert((await panel.locator('#targetState').innerText()).includes('待处理'));
  await panel.evaluate(()=>run(()=>generateDraft()));await panel.locator('#status').filter({hasText:'草稿已生成'}).waitFor();await panel.evaluate(()=>run(()=>fillDraft()));await panel.locator('#targetState').filter({hasText:'已填写（未提交）'}).waitFor();await panel.evaluate(()=>fillSessions.clear());await panel.locator('#undo').click();await panel.locator('#targetState').filter({hasText:'需人工复核'}).waitFor();assert.equal(await target.locator('textarea').inputValue(),'');
  // Browser profile reload preserves config, products and terminal ledger.
  await panel.reload();await panel.locator('#product option').nth(1).waitFor({state:'attached'});assert.equal(await panel.locator('#apiKey').inputValue(),'');
  const persisted=await panel.evaluate(async id=>LocalAPI.api('/resource',{productId:id,url:'http://resource.test/post'}),ids[0]);assert.equal(persisted.workflow.state,'submitted');
  // Canonical URL parity with Python, including quote_plus and stable duplicate-key order.
  for(const raw of ['https://EXAMPLE.com:443/?id=~,*','https://example.com/?id=中文+space','https://example.com/?id=b&id=a']){
   const {execFileSync}=require('node:child_process');const expected=execFileSync('python3',['-c','import sys;sys.path.insert(0,"chrome-form-assistant");from resource_store import canonical_url;print(canonical_url(sys.argv[1]))',raw],{cwd:path.join(__dirname,'../..')}).toString().trim();assert.equal(await panel.evaluate(raw=>LocalAPI.canonicalURL(raw),raw),expected);assert.equal(await panel.evaluate(raw=>LocalAPI.identity(raw),raw),createHash('sha256').update(expected).digest('hex'));
  }
  await panel.evaluate(async({profile,ids})=>{
   // Reimport atomicity: invalid record cannot partially replace saved model/products.
   const bad=structuredClone(profile);bad.llm.model='SHOULD-NOT-SAVE';bad.ledger=[{productId:ids[0],url:'https://bad.test',state:'public'}];
   let rejected=false;try{await LocalAPI.importProfile(bad);}catch{rejected=true;}if(!rejected)throw Error('invalid import accepted');if((await LocalAPI.configView()).model!=='gpt-5.6-sol')throw Error('partial config commit');
   // An older human confirmation dominates a newer local fill during migration.
   await LocalAPI.api('/record',{productId:ids[1],url:'https://historical.test/post',action:'filled',filledCount:1});
   const terminal=structuredClone(profile);terminal.ledger=[{productId:ids[1],url:'https://historical.test/post',state:'submitted',updatedAt:'2025-01-01T00:00:00Z',confirmedAt:'2025-01-01T00:00:00Z',confirmationSource:'用户手动确认',filledCount:1}];await LocalAPI.importProfile(terminal);
   if((await LocalAPI.api('/resource',{productId:ids[1],url:'https://historical.test/post'})).workflow.state!=='submitted')throw Error('lost imported confirmation');
   const downgraded=structuredClone(terminal);downgraded.ledger[0].state='filled';downgraded.ledger[0].updatedAt='2030-01-01T00:00:00Z';await LocalAPI.importProfile(downgraded);
   if((await LocalAPI.api('/resource',{productId:ids[1],url:'https://historical.test/post'})).workflow.state!=='submitted')throw Error('terminal state downgraded');
  },{profile,ids});
  // A changed provider origin never inherits the previous secret.
  await panel.locator('#onboard').click();await panel.locator('summary').filter({hasText:'高级模型参数'}).click();await panel.locator('#baseUrl').fill('https://other-provider.test/v1');await panel.locator('#save').click();await panel.locator('#status').filter({hasText:'更换服务域名必须提供新 API Key'}).waitFor();assert.equal((await panel.evaluate(()=>LocalAPI.configView())).base_url,'https://cubapi.codemao.cn/v1');
  providerError=true;await panel.locator('#testConnection').click();await panel.locator('#status').filter({hasText:'模型服务暂不可用'}).waitFor();await panel.locator('#closeSettings').click();assert(!(await panel.locator('#status').innerText()).includes(KEY));assert(!consoleText.join('\n').includes(KEY));assert(!requests.some(url=>/127\.0\.0\.1|localhost/.test(url)));assert(!requests.some(url=>url.includes('other-provider.test')));
  // Focused cancellation race: delayed tabs.get in guard, then a new run while old listener survives.
  await panel.evaluate(async()=>{
   const savedTabs=chrome.tabs,savedPermissions=chrome.permissions;let calls=0,nextId=0,oldGet,oldGetReady,newModelRelease,newModelReady,newPin;
   const oldStarted=new Promise(resolve=>oldGetReady=resolve),newStarted=new Promise(resolve=>newModelReady=resolve),modelWait=new Promise(resolve=>newModelRelease=resolve);
   const urls=new Map(),listeners=[],filled=[];
   chrome.permissions={request:async()=>true};
   chrome.tabs={create:async({url})=>{const id=++nextId;urls.set(id,url);return{id};},get:async id=>{calls++;if(calls===4){oldGetReady();return new Promise(resolve=>{oldGet=()=>resolve({id,url:urls.get(id),status:'complete'});});}return{id,url:urls.get(id),status:'complete'};},onUpdated:{addListener:fn=>listeners.push(fn),removeListener:fn=>{const pos=listeners.indexOf(fn);if(pos>=0)listeners.splice(pos,1);}}};
   const machine=AutoFill.create({ready:()=>true,selection:()=>({productId:'test',mode:'blog'}),canonicalURL:LocalAPI.canonicalURL,status(){},paused(){},busy(){},reset(){},analyze:async()=>{},choose:()=>({id:'form'}),selectForm(){},generate:async(signal,pin)=>{if(pin.url.endsWith('/new')){newPin=pin;newModelReady();await modelWait;}},fill:async pin=>{filled.push(pin.url);return{filled:1};}});
   try{
    machine.open('https://fixture.test/old');await oldStarted;const oldListener=listeners[0];machine.cancel();machine.open('https://fixture.test/new');await newStarted;
    oldListener(1,{url:'https://fixture.test/redirect'});if(newPin.signal.aborted)throw Error('old listener aborted new run');
    oldGet();await new Promise(resolve=>setTimeout(resolve,10));newModelRelease();await new Promise(resolve=>setTimeout(resolve,30));
    if(filled.length!==1||!filled[0].endsWith('/new'))throw Error('cancelled delayed guard reached fill');
   }finally{machine.cancel();chrome.tabs=savedTabs;chrome.permissions=savedPermissions;}
  });
  console.log('Direct-browser sidepanel passed: IndexedDB/reload, direct Responses contract, private key boundaries, no localhost, import atomicity and terminal merges, resource workflow, human confirmation, product isolation and origin-key binding. Screenshot: /tmp/form-assistant-v05-manual.png');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
