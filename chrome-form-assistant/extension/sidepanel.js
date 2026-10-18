const $ = id => document.getElementById(id);
let pendingProfile = null, context = null, draft = null, busy = false, target = null, resourcePage = 1, resourceTotal = 0;
const fillSessions = new Map();
let modelReady=false, linkedHandle=null, autoActive=false, autoPaused=null, resourceGeneration=0;
const submissionLocked = state => ['submitted','outcome_unknown','pending_review','published','submit_failed','submit_paused'].includes(state);
const stateLabels = {outcome_unknown:'结果未知 · 已锁定防重',pending_review:'等待审核',published:'已发现对应评论',submit_failed:'提交失败 · 请人工检查',submit_paused:'提交已暂停 · 请人工检查',candidate: '待处理', filled: '已填写（未提交）', submitted: '用户确认已提交', skipped: '已跳过', review_needed: '需人工复核'};
const say = text => { $('status').textContent = text; $('settingsStatus').textContent=text; };
function controls() {
  $('events').disabled=busy;$('autoSubmit').disabled=busy;
  $('fillCurrent').disabled = busy;
  $('save').disabled = busy; $('form').disabled = busy; $('mode').disabled = busy; $('product').disabled = busy;
  $('markSubmitted').disabled = busy || !target || target.workflow.state === 'submitted' || !$('confirmed').checked;
  $('resourcePrev').disabled = busy || resourcePage <= 1;
  $('resourceNext').disabled = busy || resourcePage * 10 >= resourceTotal;
  $('undo').disabled = busy; $('tracking').hidden = !target || !(['filled','review_needed'].includes(target.workflow.state)||submissionLocked(target.workflow.state));
  $('formChoice').hidden=autoPaused?.kind!=='forms';
  $('resourceFile').disabled=busy; $('linkFile').disabled=busy; $('refreshFile').disabled=busy||!linkedHandle;
  $('cancelAuto').hidden=!autoActive&&!autoPaused; $('resumeAuto').disabled=busy;
  for(const button of $('resourceList').querySelectorAll('button'))button.disabled=busy;
  $('testConnection').disabled = busy; $('profileFile').disabled = busy; $('applyProfile').disabled = busy || !pendingProfile;
}
function resetTarget() { target = null; context = null; $('confirmed').checked = false; clearDraft(); displayTarget(); }
function displayTarget() {
  $('targetState').textContent = target ? `${target.productName} · ${target.url}\n${stateLabels[target.workflow.state]}${target.workflow.detail && !['filled','partial_fill','human_confirmed'].includes(target.workflow.detail)?' · '+target.workflow.detail:''}${target.workflow.confirmedAt ? ' · ' + new Date(target.workflow.confirmedAt).toLocaleString() + ' · 用户手动确认' : ''}${target.workflow.detail === 'partial_fill' ? ' · 曾发生部分填写' : ''}` : '分析当前页面后显示。';
  $('domainWarning').textContent = !target ? '' : target.workflow.state === 'submitted' ? '该产品已在此 URL 确认提交，请在网页核对，已禁用再次填写。' : target.workflow.sameDomainSubmittedCount ? `同域名另有 ${target.workflow.sameDomainSubmittedCount} 个 URL 已确认提交，请核对是否重复。` : '';
  controls();
}
async function refreshTarget() {
  if (!target) return;
  const original=target;
  const result = await api('/resource', {productId: original.productId, url: original.url});
  if(target!==original)return;
  target.workflow = result.workflow; target.resource = result.resource;
  displayTarget();
}
async function loadResources(allowClamp = true) {
  const sequence=++resourceGeneration, selectedProduct=$('product').value;
  const result = await api('/resources', {productId: $('product').value, query: $('resourceQuery').value.trim(), type: $('resourceType').value, state: $('resourceState').value, status: $('resourceStatus').value, page: resourcePage, pageSize: 10});
  if(sequence!==resourceGeneration||selectedProduct!==$('product').value)return;
  const lastPage = Math.max(1, Math.ceil(result.total / 10));
  if (allowClamp && resourcePage > lastPage) { resourcePage = lastPage; return loadResources(false); }
  resourceTotal = result.total;
  $('resourceCount').textContent = `${result.total} 条 · 第 ${resourcePage} 页` + (result.sourceUnavailable.length ? ' · 部分来源不可用' : '');
  $('resourceList').replaceChildren();
  for (const item of result.items) {
    const box = document.createElement('div'); box.className = 'resource';
    const title = document.createElement('p'); title.textContent = item.title;
    const url = document.createElement('a'); url.textContent = item.url; url.href=item.url; url.rel='noopener noreferrer'; url.onclick=event=>{event.preventDefault();openOnly(item.url);};
    const source = document.createElement('small');
    source.textContent = `${item.type === 'historical_blog' ? '历史博客记录（非本次验证）' : '未验证候选（非已确认目录或表单）'} · ${item.observedAt || '日期未知'} · ${item.status}${item.statusConflict ? '（同日记录冲突）' : ''} · ${stateLabels[item.workflow.state]}`;
    const files = document.createElement('small'); files.textContent = '来源：' + item.sources.slice(0,3).map(s => s.file).join('、') + (item.sources.length>3?` 等 ${item.sources.length} 个快照`:'');
    const open = document.createElement('button'); open.textContent = '打开并自动填写'; open.onclick=()=>automation.open(item.url);
    open.textContent='打开填写并提交';open.className='resource-action';
    title.className='resource-title'; title.title=item.title; source.textContent=stateLabels[item.workflow.state]+' · '+(item.type==='historical_blog'?'历史记录':'未验证候选');
    box.append(title, url, source, open); $('resourceList').append(box);
  }
  controls();
}

async function run(fn) { if (busy) return; busy = true; controls(); try { await fn(); } catch (error) { say(error.message || '操作失败，请重新分析。'); } finally { busy = false; controls(); } }
async function refreshResourceList() {
  try { await loadResources(); }
  catch { say($('status').textContent + '\n外链列表更新失败，请重新搜索。'); }
}
async function api(path, body, options) { return LocalAPI.api(path, body, options); }
function openOnly(url){if(busy){say('请先取消当前任务，再打开其他目标。');return;}run(async()=>{resetTarget();say('正在打开目标，仅打开模式不会填写……');await chrome.tabs.create({url,active:true});say('目标已打开。仅打开模式不会填写；如需自动填写，请使用资源卡的主按钮。');});}
async function refreshSourceInfo(){
  const source=await LocalAPI.resourceSource();linkedHandle=await LocalAPI.resourceHandle();
  $('sourceInfo').title=source?`${source.name} · 拒绝 ${source.metadata.rejectedRows} 条 · ${new Date(source.importedAt).toLocaleString()}`:'';
  $('sourceInfo').textContent=source?`${source.name} · ${source.metadata.uniqueURLs.toLocaleString()} 条${source.linked?' · 已关联':''}`:'选择 JSON / CSV / TXT / GZ 文件，仅在本机读取';controls();
}
function onboarding(message){say(message||'在设置中保存模型后即可填写。');}
function autoReady(){if(!$('product').value){onboarding('缺少产品资料，请导入 kit.json。外链文件仍可浏览。');return false;}if(!modelReady){onboarding('尚未配置模型 API Key，请打开右上角设置。');return false;}return true;}

async function message(tabId, kind, payload) {
  const result = await chrome.tabs.sendMessage(tabId, {kind, payload});
  if (!result?.ok) throw Error(result?.error || '页面未响应，请重新分析。');
  return result.data;
}
async function current() { const [tab] = await chrome.tabs.query({active: true, currentWindow: true}); if (!tab?.id || !/^https?:\/\//.test(tab.url || '')) throw Error('请在普通 HTTP/HTTPS 网页上点击插件图标。'); return tab; }
function clearDraft() { draft = null; generatedValues=[]; controls(); }
async function products() {
  const data = await api('/products', {}), previous = $('product').value;
  $('product').replaceChildren(...data.products.map(p => new Option(p.name, p.id)));
  if (data.products.some(p=>p.id===previous)) $('product').value = previous;
  resetTarget(); resourcePage = 1;
  say('产品已加载，正在读取本地外链文件……');
  await refreshSourceInfo();await loadResources();
  if(!modelReady)onboarding('尚未配置模型 API Key，点右上角设置。可先浏览外链。');
  else say('已就绪，选择当前网页或一条外链开始填写。');
}
async function displayConfig() {
  const cfg = await LocalAPI.configView();modelReady=cfg.hasKey;
  $('baseUrl').value = cfg.base_url; $('model').value = cfg.model; $('wire').value = cfg.wire_api; $('effort').value = cfg.reasoning_effort;
  $('apiKey').value = ''; $('keyState').textContent = cfg.hasKey ? '已保存（不回显）' : '尚未保存';
}
function readModelSettings() { return {base_url: $('baseUrl').value.trim(), model: $('model').value.trim(), wire_api: $('wire').value, reasoning_effort: $('effort').value, api_key: $('apiKey').value.trim()}; }
function requestModelPermission(origin) {
  // Called synchronously from the click handler, before any await or run wrapper.
  return origin === 'https://cubapi.codemao.cn' ? Promise.resolve(true) : chrome.permissions.request({origins:[origin + '/*']});
}
function selectedGroup() { return context?.snapshot.groups.find(g => g.id === $('form').value); }
let generatedValues=[];
function render(values){generatedValues=values;}
function draftValues(){return generatedValues.filter(item=>item.value);}
async function history(entry) {
  const {history = []} = await chrome.storage.local.get('history');
  if (entry) { history.unshift(entry); history.splice(20); await chrome.storage.local.set({history}); }

}
$('save').onclick = () => {
  let raw, permission;
  try { raw = readModelSettings(); permission = requestModelPermission(LocalAPI.configShape(raw).origin); }
  catch (error) { say(error.message); return; }
  permission.then(granted => run(async () => { if (!granted) throw Error('未授权模型服务域名，配置未保存。'); await LocalAPI.saveConfig(raw); await displayConfig(); say('模型设置已保存在本机扩展数据库。可点击测试连接；测试会调用模型。'); })).catch(()=>say('模型域名授权失败，配置未保存。'));
};
$('testConnection').onclick = () => run(async () => { say('正在直接测试已保存的模型服务……'); await LocalAPI.testConnection(); say('模型连接成功，JSON 输出正常。'); });
$('profileFile').onchange = () => run(async () => {
  pendingProfile = null; $('importSummary').textContent = '';
  const file = $('profileFile').files[0]; if (!file) return;
  if (file.size > 20 * 1024 * 1024) throw Error('导入文件过大，最多支持 20 MiB。');
  let raw; try { raw = JSON.parse(await file.text()); } catch { throw Error('导入文件不是有效 JSON。'); }
  const prepared = await LocalAPI.prepareProfile(raw);
  pendingProfile = raw;
  $('importSummary').textContent = `已检查：${prepared.products.length} 个产品、${prepared.records.length} 条工作记录` + (prepared.llm ? `；模型服务 ${prepared.llm.origin}。` : '；不修改已有模型设置。');
  say('文件检查通过。请点击应用导入；此步骤不会调用模型。');
});
$('applyProfile').onclick = () => {
  if (!pendingProfile) return;
  let permission;
  try { permission = pendingProfile.llm ? requestModelPermission(LocalAPI.configShape(pendingProfile.llm).origin) : Promise.resolve(true); }
  catch (error) { say(error.message); return; }
  permission.then(granted => run(async () => {
    if (!granted) throw Error('未授权模型服务域名，未导入任何内容。');
    const result = await LocalAPI.importProfile(pendingProfile);
    pendingProfile = null; $('profileFile').value = ''; $('importSummary').textContent = '';
    await displayConfig(); await products();
    say(`已导入 ${result.products} 个产品、检查 ${result.records} 条记录；已有较新记录和已确认提交状态会保留。无需启动服务器。`);
  })).catch(()=>say('模型域名授权失败，未导入任何内容。'));
};
async function analyzePage(tab,pin=null) {
  if(pin)await automation.guard(pin);
  resetTarget();
  const found = await api('/resource', {productId: $('product').value, url: pin?(pin.resourceUrl||pin.url):tab.url});
  if(pin)await automation.guard(pin);
  target = {url: found.workflow.url, productId: $('product').value, productName: $('product').selectedOptions[0].textContent, workflow: found.workflow, resource: found.resource};
  displayTarget();
  if(submissionLocked(found.workflow.state))throw Error('此目标已有提交记录或结果未知，禁止重复自动操作。');
  try{await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['content.js']});}catch{throw Error('无法访问目标网页，请在目标网页点击插件图标后重试。');}
  if(pin)await automation.guard(pin);
  const snapshot = await message(tab.id, 'analyze');
  if(pin)await automation.guard(pin);
  context = {tabId: tab.id, fullUrl: tab.url, snapshot,productId:$('product').value,mode:$('mode').value};
  $('form').replaceChildren(...snapshot.groups.map((g, i) => new Option(`${i+1}. ${g.label} (${g.fields.length} 项)`, g.id)));
  const preferred = snapshot.groups.find(g => /comment|reply|评论|留言|submit.?tool|add.?site|directory|目录/i.test(g.label + ' ' + g.fields.map(f => f.label).join(' ')));
  if (preferred) $('form').value = preferred.id;

  say(snapshot.body ? '分析完成。请选择正确的表单，再生成草稿。' : '未提取到文章正文。目录描述可生成；博客评论将留空。');
}

async function generateDraft(signal,pin=null) {
  clearDraft(); const group = selectedGroup(); if (!group) throw Error('请重新分析页面。');
  say('正在生成草稿……');
  const result = await api('/generate', {productId: $('product').value, mode: $('mode').value, page: {title: context.snapshot.title, body: context.snapshot.body, language: context.snapshot.language}, fields: group.fields},{signal});
  if(pin)await automation.guard(pin);
  draft = {formId: group.id, mode: $('mode').value, productId: $('product').value};
  render(result.values); say(result.summary + (result.missing.length ? '\n留空待补充：' + result.missing.join('、') : ''));
}

async function fillDraft(pin=null) {
  const original={target:{...target},context:{...context},draft:{...draft},fields:selectedGroup().fields,values:draftValues(),emitEvents:$('events').checked};
  const publish=()=>!pin||automation.isCurrent(pin);
  const tab=pin?await automation.guard(pin):await current();
  if(tab.id!==original.context.tabId||tab.url!==original.context.fullUrl)throw Error('当前标签页已变化，请重新分析。');
  const found=await api('/resource',{productId:original.target.productId,url:original.target.url});
  if(pin)await automation.guard(pin);
  if(submissionLocked(found.workflow.state))throw Error('此目标已确认提交，禁止重复填写，请在网页核对。');
  if(!original.values.length)throw Error('没有可填写的草稿。');
  const checked=await api('/validate',{productId:original.draft.productId,mode:original.draft.mode,page:{},fields:original.fields,resourceUrl:original.target.url,values:original.values});
  const still=pin?await automation.guard(pin):await current();
  if(still.id!==original.context.tabId||still.url!==original.context.fullUrl)throw Error('当前标签页已变化，请重新分析。');
  const trackingId=crypto.randomUUID();fillSessions.set(trackingId,{productId:original.target.productId,url:original.target.url});
  const result=await message(original.context.tabId,'fill',{documentId:original.context.snapshot.documentId,snapshotId:original.context.snapshot.snapshotId,formId:original.draft.formId,values:checked.values,emitEvents:original.emitEvents,trackingId,ledgerContext:{productId:original.target.productId,url:original.target.url}});
  if(pin)pin.filled=result.filled;
  const outcome=`已填写 ${result.filled} 项，跳过 ${result.skipped} 项。${result.aborted?'页面发生变化，已停止后续填写。':''}${$('autoSubmit').checked?'即将检查并自动提交；验证码或登录会暂停。':'请在网页检查后手动提交。'}`;
  if(publish())say(outcome);
  let recorded=false;
  if(result.filled>0){
    try{
      await api('/record',{productId:original.target.productId,url:original.target.url,action:'filled',filledCount:result.filled,aborted:result.aborted===true});recorded=true;
      if(publish()){await refreshTarget();if(publish())say(outcome+(result.aborted?'\n部分填写已记录为需复核。':'\n已记录为已填写，尚未提交。'));}
    }catch{if(publish())say(outcome+'\n网页已填写，但本机记录失败。请勿因此重复填写；可重新分析核对状态。');}
  }
  if(recorded&&publish())await refreshResourceList();
  try{await history({time:Date.now(),site:new URL(original.context.fullUrl).hostname,count:result.filled});}catch{}
  result.recorded=recorded;
  return result;
}


async function submitDraft(pin, filled) {
  if(!$('autoSubmit').checked)return;
  if(!filled?.recorded || !filled.filled || filled.aborted || filled.skipped)throw Error('填写不完整、包含已有内容或记录失败，已暂停自动提交，请人工检查。');
  if($('events').checked)throw Error('已启用网页输入事件，可能已触发网站自动保存；已暂停以避免重复提交。');
  await automation.guard(pin);
  const payload={documentId:context.snapshot.documentId,snapshotId:context.snapshot.snapshotId,formId:draft.formId,mode:pin.mode};
  const prepared=await message(pin.tabId,'prepareSubmit',payload);
  await automation.guard(pin);
  const ledger={productId:target.productId,url:target.url,attemptId:crypto.randomUUID()};
  // Commit the lock before sending the click. A closed panel or lost reply stays unknown.
  await api('/record',{...ledger,action:'attempt'});
  let outcome={state:'outcome_unknown',evidence:'提交结果未知，已禁止自动重试。'};
  try {
    await automation.guard(pin);
    const response=await message(pin.tabId,'submit',{...payload,ticket:prepared.ticket});
    if(response?.paused)outcome={state:'submit_paused',evidence:response.reason};
  } catch { /* Navigation can destroy the response channel after a successful click. */ }
  if(outcome.state==='outcome_unknown') {
    say('已锁定此目标，正在检查提交结果……');
    for(let i=0;i<12;i++) {
      if(!automation.isCurrent(pin))break;
      await new Promise(resolve=>setTimeout(resolve,750));
      try {
        const tab=await chrome.tabs.get(pin.tabId);
        if(new URL(tab.url).origin!==new URL(pin.url).origin){outcome={state:'submit_paused',evidence:'提交后跨站跳转，已暂停；请检查登录或验证页面。'};break;}
        await chrome.scripting.executeScript({target:{tabId:pin.tabId},files:['content.js']});
        const result=await message(pin.tabId,'submissionResult',prepared.probe);
        if(result.state!=='outcome_unknown'){outcome=result;break;}
      } catch { /* Keep unknown, never submit again. */ }
    }
  }
  await api('/record',{...ledger,action:'result',...outcome});
  if(automation.isCurrent(pin)){await refreshTarget();await refreshResourceList();say(stateLabels[outcome.state]+'。'+outcome.evidence);}
}

$('undo').onclick = () => run(async () => {
  const original=context;if(!original||!target)throw Error('没有可撤销的填写目标。');
  let tab;try{tab=await chrome.tabs.get(original.tabId);}catch{throw Error('填写目标标签页已关闭，无法撤销。');}
  if(context!==original||new URL(tab.url).href!==new URL(original.fullUrl).href)throw Error('填写目标页面已变化，无法撤销；请在网页检查。');
  const result=await message(original.tabId,'undo',{documentId:original.snapshot.documentId});
  let recordFailed = false;
  const sessions = result.ledgerContexts?.length ? result.ledgerContexts : (result.trackingIds || []).map(id => fillSessions.get(id));
  for (const session of sessions) {
    if (!session) { recordFailed = true; continue; }
    try { await api('/record', {...session, action: 'undo'}); } catch { recordFailed = true; }
  }
  for (const id of result.trackingIds || []) fillSessions.delete(id);
  try { await refreshTarget(); } catch { recordFailed = true; }
  say(`已撤销 ${result.restored} 项；${result.skipped} 项已变化，保留现状。` + (recordFailed ? '\n页面已撤销，但部分状态记录失败或属于旧侧边栏会话，请核对记录。' : '\n相关填写记录已标为需复核；用户确认提交状态不会被撤销。'));
  await refreshResourceList();
});
for (const id of ['form', 'mode']) $(id).onchange = () => { $('confirmed').checked = false; clearDraft(); };
$('product').onchange = () => run(async () => { resetTarget(); resourcePage = 1; await loadResources(); say('产品已切换，可填写当前页或选择外链。'); });
$('confirmed').onchange = controls;
$('markSubmitted').onclick = () => run(async () => {
  if (!target || !$('confirmed').checked || target.productId !== $('product').value) throw Error('请核对目标与产品，并勾选手动提交确认。');
  const result = await api('/record', {productId: target.productId, url: target.url, action: 'submitted', humanConfirmed: true});
  target.workflow = result.workflow; $('confirmed').checked = false; displayTarget();
  say('已记录为用户手动确认提交。尚未验证公开、收录或链接有效性。');
  await refreshResourceList();
});
$('resourcePrev').onclick = () => run(async () => { resourcePage = Math.max(1, resourcePage - 1); await loadResources(); });
$('resourceNext').onclick = () => run(async () => { resourcePage++; await loadResources(); });
$('onboard').onclick=()=>{$('settings').showModal();};
$('closeSettings').onclick=()=>{$('settings').close();};
let searchTimer;
function searchResources(){clearTimeout(searchTimer);resourcePage=1;loadResources().catch(error=>say(error.message));}
$('resourceQuery').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(searchResources,220);};
$('resourceQuery').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();searchResources();}};
for(const id of ['resourceType','resourceState','resourceStatus'])$(id).onchange=searchResources;
$('resourceFile').onchange=()=>run(async()=>{const file=$('resourceFile').files[0];if(!file)return;say('正在本机解析外链文件；不会上传服务器……');try{await LocalAPI.importResources(file);await refreshSourceInfo();resourcePage=1;await loadResources();say('本地文件已导入。点击资源卡可打开并自动填写；最后由你手动提交。');}finally{$('resourceFile').value='';}});
$('linkFile').onclick=()=>{
 if(!window.showOpenFilePicker){say('此浏览器不支持关联文件，请使用“导入文件副本”。');return;}
 let chosen;try{chosen=window.showOpenFilePicker({multiple:false,types:[{description:'外链 JSON / CSV / TXT / GZ',accept:{'application/octet-stream':['.json','.csv','.txt','.gz']}}]});}catch{say('无法打开文件选择器，请使用导入文件副本。');return;}
 chosen.then(handles=>run(async()=>{say('正在读取你选择的本地原文件……');const handle=handles[0];await LocalAPI.importResources(await handle.getFile(),handle);await refreshSourceInfo();resourcePage=1;await loadResources();say('已关联原文件。以后修改文件后点击“刷新关联文件”；不会自动读取其他路径。');})).catch(()=>say('未选择或未授权本地文件，已有资源保持不变。'));
};
$('refreshFile').onclick=()=>{
 if(!linkedHandle){say('当前是导入副本；请先关联原文件，或重新导入副本。');return;}
 const handle=linkedHandle;let permission;
 try{permission=handle.requestPermission({mode:'read'});}catch{say('无法请求文件读取权限，请重新关联原文件。');return;}
 Promise.resolve(permission).then(value=>run(async()=>{if(value!=='granted')throw Error('未授权读取本地文件，已有资源保持不变。');say('正在刷新已关联文件……');let file;try{file=await handle.getFile();}catch{throw Error('关联文件已移动、删除或不可读；已有资源保持不变，请重新关联。');}await LocalAPI.importResources(file,handle);await refreshSourceInfo();resourcePage=1;await loadResources();say('已刷新关联文件，显示的是该文件当前的外链。');})).catch(()=>say('本地文件授权失败，已有资源保持不变。'));
};
function supportedGroups(){
 return(context?.snapshot.groups||[]).filter(group=>{
  if(group.hasCaptcha||/contact|newsletter|sign.?up|register|subscribe|联系|订阅|注册/i.test(group.label))return false;
  const labels=group.label+' '+group.fields.map(field=>field.label).join(' ');
  if($('mode').value==='blog')return group.fields.some(field=>field.type==='textarea')&&/comment|reply|respond|评论|留言/i.test(labels);
  const website=group.fields.some(field=>field.type==='url'||/website|url|网站|网址/i.test(field.label));
  const explicitProduct=group.fields.some(field=>/product.?name|tool.?name|site.?name|app.?name|产品名|工具名|网站名/i.test(field.label));
  const description=group.fields.some(field=>field.type==='textarea'&&/description|about|介绍|描述/i.test(field.label));
  return website&&(/directory|submit.{0,20}(tool|site|product|listing)|add.{0,20}(tool|site|product)|目录|提交/i.test(group.label)||explicitProduct&&description);
 });
}
const automation=AutoFill.create({
 status:say,ready:autoReady,selection:()=>({productId:$('product').value,mode:$('mode').value}),canonicalURL:LocalAPI.canonicalURL,
 reset:resetTarget,busy:value=>{autoActive=value;busy=value;controls();},
 paused:value=>{autoPaused=value;$('resumeAuto').hidden=!value;$('resumeAuto').textContent=value?.kind==='redirect'?'授权跳转地址并继续':'选择表单后继续';controls();},
 analyze:analyzePage,generate:generateDraft,fill:fillDraft,submit:submitDraft,
 choose:explicit=>{
  const groups=supportedGroups();
  if((context?.snapshot.groups||[]).some(group=>group.hasCaptcha)&&!groups.length)return{error:'页面包含验证码，自动填写已停止。请在网页手动处理，不会绕过验证码。'};
  if($('mode').value==='blog'&&!context?.snapshot.body.trim())return{error:'未提取到文章正文，已停止自动评论。请手动检查页面。'};
  if(explicit){const group=groups.find(group=>group.id===$('form').value);return group?{id:group.id}:{error:'所选表单不符合当前场景或含验证码，请手动处理。'};}
  if(groups.length>1)return{ambiguous:true};if(groups.length===1)return{id:groups[0].id};
  return{error:'没有找到明确的博客评论 / 目录提交表单。已停止；请在网页手动处理。'};
 },selectForm:id=>{$('form').value=id;},
});
$('autoSubmit').checked=localStorage.getItem('autoSubmit')!=='false';
$('autoSubmit').onchange=()=>localStorage.setItem('autoSubmit',String($('autoSubmit').checked));
$('fillCurrent').onclick=()=>automation.current();
$('resumeAuto').onclick=()=>automation.resume();$('cancelAuto').onclick=()=>automation.cancel();
(async()=>{
 say('正在初始化本机资料和默认产品……');
 try{await LocalAPI.init();await displayConfig();await history();await run(products);}
 catch(error){say(error.message||'本机初始化失败；请关闭旧插件页并刷新扩展，或导入产品资料。');}
 controls();
})();
