const $ = id => document.getElementById(id);
let pendingProfile = null, context = null, draft = null, busy = false, target = null, resourcePage = 1, resourceTotal = 0;
const fillSessions = new Map();
let modelReady=false, linkedHandle=null, autoActive=false, autoPaused=null, resourceGeneration=0;
const submissionLocked = state => ['submitted','outcome_unknown','pending_review','published','submit_failed','submit_paused'].includes(state);
const stateLabels = {outcome_unknown:'结果未知 · 已锁定防重',pending_review:'等待审核',published:'已发现对应评论',submit_failed:'提交失败 · 请人工检查',submit_paused:'提交已暂停 · 请人工检查',candidate: '待处理', filled: '已填写（未提交）', submitted: '用户确认已提交', skipped: '已跳过', review_needed: '需人工复核'};
const say = text => { $('status').textContent = text; $('settingsStatus').textContent=text; };
function controls() {
  $('captureSemrush').disabled=busy;
  $('captureAhrefs').disabled=busy;
  for(const id of ['analyzeLibrary','publishLibrary','publishDomain','publisherName','publisherEmail','publishLimit','publishAction','refreshEvidence'])$(id).disabled=busy;
  $('resumeDiscovery').disabled=busy; $('recursionRounds').disabled=busy; $('scanConcurrency').disabled=busy; $('reportPageLimit').disabled=busy; $('commentPageLimit').disabled=busy;
  for(const button of $('ahrefsGroups').querySelectorAll('button'))button.disabled=busy;
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
  $('saveCodex').disabled=busy; $('disableCodex').disabled=busy; $('testConnection').disabled = busy; $('profileFile').disabled = busy; $('applyProfile').disabled = busy || !pendingProfile;
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
    const open = document.createElement('button'); open.textContent = '打开并自动填写'; open.onclick=()=>{showPane('publishPane');automation.open(item.url);};
    open.textContent='打开填写并提交';open.className='resource-action';
    title.className='resource-title'; title.title=item.title; source.textContent=stateLabels[item.workflow.state]+' · '+(item.type==='historical_blog'?'历史记录':'未验证候选');
    box.append(title, url, source, open); $('resourceList').append(box);
  }
  controls();
}

async function run(fn) { if (busy) return; busy = true; controls(); try { await fn(); } catch (error) { say(error.message || '操作失败，请重新分析。'); } finally { busy = false; controls(); } }
async function refreshResourceList() {
  try { await loadResources(); await refreshLibraryRecords(); }
  catch { say($('status').textContent + '\n外链列表更新失败，请重新搜索。'); }
}
async function api(path, body, options) { return LocalAPI.api(path, body, options); }
function openOnly(url){if(busy){say('请先取消当前任务，再打开其他目标。');return;}run(async()=>{resetTarget();say('正在打开目标，仅打开模式不会填写……');await chrome.tabs.create({url,active:true});say('目标已打开。仅打开模式不会填写；如需自动填写，请使用资源卡的主按钮。');});}
const ahrefsGroups = new Map();
const ahrefsStorageKey = 'ahrefsBacklinkGroups';
function showPane(id) {
  for (const button of $('workflowTabs').querySelectorAll('button[data-pane]')) {
    const selected = button.dataset.pane === id;
    $(button.dataset.pane).hidden = !selected;
    button.setAttribute('aria-pressed', String(selected));
  }
}
$('workflowTabs').onclick = event => {
  const button = event.target.closest('button[data-pane]');
  if (button) showPane(button.dataset.pane);
};
async function loadAhrefsGroups() {
  const stored = (await chrome.storage.local.get(ahrefsStorageKey))[ahrefsStorageKey] || [];
  ahrefsGroups.clear();
  for (const {target, links} of stored) ahrefsGroups.set(target, links);
}
function renderAhrefs(){renderCollectedCards();}
$('spamFilter').value = localStorage.getItem('backlinkSpamFilter') || 'all';
if (!$('spamFilter').value) $('spamFilter').value = 'all';
$('spamFilter').onchange = () => {
  localStorage.setItem('backlinkSpamFilter',$('spamFilter').value);
  renderAhrefs();controls();
};
$('captureAhrefs').onclick = () => {
  if (busy) return;
  const status = $('ahrefsStatus');
  status.textContent = '正在读取 Ahrefs 结果……';
  const permission = chrome.permissions.request({origins:['https://*/*','http://*/*']});
  return run(async () => {
    try {
      if (!await permission) throw Error('未授权读取 Ahrefs 页面，请重试并允许。');
      await captureAhrefs();
    } catch(error) {
      status.textContent = error.message || '无法获取 Ahrefs 外链。';
    }
  });
};
async function captureAhrefs() {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id) throw Error('找不到当前标签页。');
  const detected=websiteContext(tab.url);
  if(detected?.service!=='ahrefs'||!detected.report){
    const raw=$('ahrefsTarget').value.trim()||detected?.domain;
    if(!raw)throw Error('请打开要查询的网站，或填写目标域名。');
    const domain=semrushStart(raw).target;
    const report=new URL('https://ahrefs.com/backlink-checker/');
    report.searchParams.set('input','https://'+domain+'/');report.searchParams.set('mode','subdomains');
    await chrome.tabs.create({url:report.href,active:true});
    $('ahrefsStatus').textContent='已打开 '+domain+' 的 Ahrefs 查询。完成网页验证、显示结果后，再点获取。';
    return;
  }
  let result;
  try {
    [{result}] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:readAhrefsResults});
  } catch {throw Error('请在 Ahrefs 免费反链检查器标签页点击扩展图标，再点「获取 Ahrefs 外链」。');}
  if (!result || result.error) throw Error(result?.error || '没有读取到 Ahrefs 结果。');
  if (!result.rows.length) throw Error('未识别到可见的来源页列表。请先完成验证并打开反链明细。');
  const raw = result.target || $('ahrefsTarget').value.trim();
  if (!raw) throw Error('查询地址没有目标网站，请填写「查询的目标网站」后再点获取。');
  const {website,added,total} = await saveCollected(raw,result.rows);
  await afterCollection(result.rows);
  $('ahrefsTarget').value = website;
  $('ahrefsStatus').textContent = '本次读取 ' + result.rows.length + ' 条，新增 ' + added + ' 条；该网站已在本机保存 ' + total + ' 条。';
}
async function saveCollected(raw, rows) {
  const website = URLTools.canonicalURL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  return navigator.locks.request(ahrefsStorageKey, async () => {
    await loadAhrefsGroups();
    const links = new Map((ahrefsGroups.get(website)||[]).map(item=>[item.url,item]));
    let added = 0;
    for (const item of rows) {
      let url;try { url=URLTools.canonicalURL(item.url); }catch {continue;}
      if (url===website) continue;
      const previous = links.get(url);
      const kinds=new Set([...(previous?.resourceKinds|| (previous?[ResourcePolicy.isAuthor(previous)?'author':'source']:[])),...(item.resourceKinds||[ResourcePolicy.isAuthor(item)?'author':'source'])]);
      links.set(url,{...previous,url,resourceKinds:[...kinds],title:ResourcePolicy.isAuthor(item)&&previous&&!ResourcePolicy.isAuthor(previous)?previous.title:item.title || previous?.title || '',
        ...(item.riskEvidence ? {riskEvidence:item.riskEvidence} : {})});
      if (!previous) added++;
    }
    if(!links.size)throw Error('结果里没有可保存的来源网址。');
    const next = new Map(ahrefsGroups).set(website,[...links.values()]);
    try {
      await chrome.storage.local.set({[ahrefsStorageKey]:[...next].map(([target,links])=>({target,links}))});
    } catch { throw Error('本次外链未保存：浏览器扩展存储不可用或已满。'); }
    ahrefsGroups.set(website,next.get(website));
    renderAhrefs(website);
    return {website,added,total:links.size};
  });
}
async function discoveryRequest(path, data, pairingToken = null) {
  const token = pairingToken || localStorage.getItem('codexBridgeToken');
  if (!token) throw Error('请先在设置中启用 Codex CLI 本机桥接。');
  let response;
  try {
    response = await fetch('http://127.0.0.1:8795/'+path,{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify(data),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(path==='health'?5000:110000)});
  } catch(error) {throw Error(error.name==='TimeoutError'?'等待本机桥接响应超时；外链已保存，请检查桥接终端后继续。':'无法连接本机桥接。请启动新版桥接并核对配对码。');}
  if(path==='health' && [400,404].includes(response.status))throw Error('桥接版本过旧，请关闭旧桥接终端并启动新版，再重新保存配对码。');
  const result = await response.json().catch(()=>null);
  if (!response.ok || result?.error) throw Error(result?.error || ({
    403:'配对失败，请重新保存桥接配对码。',404:'请重启为新版桥接。',429:'桥接正在处理另一项任务。',504:'Codex CLI 在 100 秒内没有返回结果。外链已保存；请检查 CLI 网络或模型可用性后继续，此步骤不需要 CDP。'
  }[response.status] || '桥接未返回可用结果，请检查本机终端。'));
  return result;
}
function discovery(action) {
  return run(async()=>{
    const status=$('discoveryStatus');
    status.textContent='正在处理……';
    try{status.textContent=await action();}
    catch(error){status.textContent=error.message;}
  });
}
function semrushStart(input) {
  if (!input) return null;
  let url = new URL('https://sem.3ue.co/analytics/backlinks/backlinks/');
  let target = input;
  if (/^https?:\/\//i.test(input)) {
    const supplied = new URL(input);
    if (supplied.origin === url.origin && /^\/analytics\/backlinks\/(pages|backlinks)\/?$/i.test(supplied.pathname)) {
      target = supplied.searchParams.get('q') || '';
      url = new URL(supplied.href);
      url.pathname='/analytics/backlinks/backlinks/';
      url.hash='';
    } else target = new URL(URLTools.canonicalURL(input)).hostname;
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(target))
    throw Error('请输入有效域名，例如 pixverse.ai，或完整 Semrush 镜像报告链接。');
  url.searchParams.set('q',target.toLowerCase());
  url.searchParams.set('searchType','domain');
  url.searchParams.delete('page');
  url.searchParams.set('ba_rpp','blog');
  url.searchParams.set('ba_mt','active');
  url.searchParams.set('ba_rel','ugc');
  if(!url.searchParams.has('sort_field'))url.searchParams.set('sort_field','firsttime');
  return {url:url.href,target:target.toLowerCase()};
}
$('captureSemrush').onclick=()=>{
  if(busy)return;
  const input=$('semrushTarget').value.trim();
  const permission=chrome.permissions.request({origins:['https://*/*','http://*/*']});
  return discovery(async()=>{
    if(!await permission)throw Error('需要允许读取 Semrush 镜像，才能自动打开并采集。');
    const {context}=await activeWebsiteContext();
    const requested=input?semrushStart(input).target:context?.domain;
    if(!requested&&!context?.report)throw Error('请打开要查询的网站，或填写目标域名。');
    const useCurrent=context?.service==='semrush'&&context.report&&(!requested||requested===context.domain);
    const report=await collectSemrush(useCurrent?'':input||requested);
    const saved=report.capture||await saveCollected(report.target,report.rows);
    if(!collectionStopped)await afterCollection(report.rows);
    return `读取 ${report.rows.length} 条，新增 ${saved.added} 条。已按目标保存。${report.capture?.reason||''}`;
  });
};
async function collectSemrush(input,recursive=false){
    if(!recursive){collectionStopped=false;$('stopReport').hidden=false;}
    const start=semrushStart(input);
    const tab=start?await chrome.tabs.create({url:start.url,active:!recursive}):
      (await chrome.tabs.query({active:true,currentWindow:true}))[0];
    if(!tab?.id)throw Error('找不到报告标签页。');
    try {
    let switched=false;
    for(let attempt=0;attempt<45;attempt++){
      if(recursive?scanStopped:collectionStopped)throw Error('已停止采集');
      const current=await chrome.tabs.get(tab.id);
      let report;
      if(current.status==='complete'){
        try {
          [{result:report}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:readSemrushReport});
        } catch {
          if(!start)throw Error('请在 Semrush 明细标签页点击扩展图标后采集，或先输入目标域名。');
        }
      }
      if(report?.error)throw Error(report.error);
      if(report?.detail&&!switched){
        switched=true;
        await chrome.tabs.update(tab.id,{url:report.detail});
        $('discoveryStatus').textContent='已切换到反链来源明细，正在等待表格……';
      } else if(report?.rows?.length){
        if(!report.target || (start && report.target.toLowerCase()!==start.target))
          throw Error('报告目标与查询不一致，未保存。');
        return await collectReportPages(tab.id,report,recursive);
      }
      await new Promise(resolve=>setTimeout(resolve,650));
    }
    throw Error('等待反链明细超时。请检查打开的报告是否已登录且有数据；也可清空输入框后采集当前明细页。');
    } finally { if(!recursive)$('stopReport').hidden=true; if(recursive && start)await chrome.tabs.remove(tab.id).catch(()=>{}); }
}
const blogKey='discoveredBlogComments';
async function renderBlogEvidence(){
  const stored=(await chrome.storage.local.get(blogKey))[blogKey]||[];
  const panel=$('blogEvidence');panel.replaceChildren();
  for(const group of stored){
    const box=document.createElement('details'), title=document.createElement('summary');
    title.textContent=group.url+' · '+group.items.length+' 条已保存评论';
    box.append(title);
    for(const entry of group.items){
      const p=document.createElement('p');p.textContent=entry.text;box.append(p);
    }
    panel.append(box);
  }
}
async function saveBlogComments(page){
  if(!page.items.length)return '未识别到已加载的评论。';
  const url=URLTools.canonicalURL(page.url);
  const source=new URL(url);
  // WordPress comment pagination refers to the same article.
  source.pathname=source.pathname.replace(/\/comment-page-\d+\/?$/i,'/');
  source.searchParams.delete('cpage');
  const article=URLTools.canonicalURL(source.href);
  const sites=new Map();
  const items=page.items.map(item=>({
    text:item.text,links:(item.links||[]).slice(0,20),sites:item.sites.flatMap(raw=>{
      try{
        const href=URLTools.canonicalURL(raw);
        if(URLTools.searchResultReason(href))return [];
        if(new URL(href).hostname.replace(/^www\./,'')===source.hostname.replace(/^www\./,''))return [];
        sites.set(href,{url:href,title:'评论者公开网址（待验证）',resourceKinds:['author']});return [href];
      }catch{return [];}
    })
  }));
  await navigator.locks.request(blogKey,async()=>{
    const stored=(await chrome.storage.local.get(blogKey))[blogKey]||[];
    const groups=new Map(stored.map(group=>[group.url,group.items]));
    const merged=new Map((groups.get(article)||[]).map(item=>[JSON.stringify([item.text,item.sites]),item]));
    for(const item of items)merged.set(JSON.stringify([item.text,item.sites]),item);
    groups.set(article,[...merged.values()]);
    await chrome.storage.local.set({[blogKey]:[...groups].map(([url,items])=>({url,items}))});
  });
  if(sites.size)await saveCollected(article,[...sites.values()]);
  await renderBlogEvidence();
  return `已读取 ${items.length} 条评论、${sites.size} 个评论者网址，已保存到资源库。`+
    (page.more?' 有评论分页；请翻页后再次收集。':' 仅包含网页当前已加载的评论。');
}
$('exportAhrefs').onclick = () => {
  const groups = [...ahrefsGroups].map(([target,links])=>({target,links:links.filter(item=>matchesCollected(item)).map(item=>({...item,blogAssessment:scanJobs.find(j=>j.url===item.url)}))})).filter(group=>group.links.length);
  const items = groups.flatMap(group=>group.links.map(row=>({...row,target:group.target,title:group.target+' ← '+(row.title||row.url)})));
  const url = URL.createObjectURL(new Blob([JSON.stringify({groups,items},null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='ahrefs-backlinks.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
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
  await refreshSourceInfo();await loadResources();await refreshLibraryRecords();
  if(!modelReady)onboarding('请在设置中启用 Codex CLI 或配置模型 API Key。可先浏览外链。');
  else say('已就绪，选择当前网页或一条外链开始填写。');
}
async function displayConfig() {
  const cfg = await LocalAPI.configView();modelReady=cfg.hasKey||!!localStorage.getItem('codexBridgeToken');
  $('codexToken').value='';
  $('codexState').textContent=localStorage.getItem('codexBridgeToken')?'已启用 Codex CLI；用「测试连接」检查。':'当前使用 API Key 模式。';
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
$('saveCodex').onclick=()=>{
  const token=$('codexToken').value.trim();
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)){say('请输入桥接终端显示的完整配对码。');return;}
  chrome.permissions.request({origins:['http://127.0.0.1/*']}).then(granted=>run(async()=>{
    if(!granted)throw Error('需要授权访问本机桥接。');
    say('正在核验配对码……');
    const health=await discoveryRequest('health',{},token);
    if(health.ok!==true)throw Error('桥接未返回有效的配对确认，未保存新配对码。');
    localStorage.setItem('codexBridgeToken',token);await displayConfig();say('配对已验证，Codex CLI 已启用。可测试模型连接或继续分析。');
  })).catch(()=>say('本机桥接授权失败。'));
};
$('disableCodex').onclick=()=>run(async()=>{localStorage.removeItem('codexBridgeToken');await displayConfig();say('已切回 API Key 模式。');});
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
$('product').onchange = () => run(async () => { resetTarget(); resourcePage = 1; await loadResources(); await refreshLibraryRecords(); say('产品已切换，可填写当前页或选择外链。'); });
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
 reset:resetTarget,busy:value=>{autoActive=value;busy=value||batchActive;controls();},
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
$('resumeAuto').onclick=()=>automation.resume();$('cancelAuto').onclick=()=>{batchStopped=true;automation.cancel();};
initDiscovery();initLibrary();initPublish();initTargetContext();
$('stopReport').onclick=()=>{collectionStopped=true;};
for(const id of ['reportPageLimit','commentPageLimit']){
 $(id).value=localStorage.getItem(id)||'3';
 $(id).onchange=()=>localStorage.setItem(id,$(id).value);
}
(async()=>{
 say('正在初始化本机资料和默认产品……');
 try{scanJobs=(await chrome.storage.local.get(scanKey))[scanKey]||[];updateScanStatus(scanJobs);await loadAhrefsGroups();renderAhrefs();}
 catch{$('ahrefsStatus').textContent='无法读取本机保存的 Ahrefs 外链。';}
 try{await renderBlogEvidence();}
 catch{$('discoveryStatus').textContent='无法读取本机保存的博客评论。';}
 try{await LocalAPI.init();await displayConfig();await history();await run(products);}
 catch(error){say(error.message||'本机初始化失败；请关闭旧插件页并刷新扩展，或导入产品资料。');}
 controls();
 await refreshCurrentWebsite();
})();
