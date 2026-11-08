const scanKey='blogScanJobs', recursionKey='blogRecursionTasks';
let scanJobs=[], scanStopped=false, scanner=null;
const scanLive=new Map();
const guestLabel=v=>({likely_guest:'可发布（疑似免登录）',login_required:'需要登录',link_unverified:'可留言，留链待验证',unknown:'无法确认'}[v]||'未分析');
const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function scanProgressLabel(url){
  const index=scanJobs.findIndex(job=>job.url===url);
  const done=scanJobs.filter(job=>job.state==='done').length;
  const failed=scanJobs.filter(job=>job.state==='failed').length;
  return `${index>=0?`正在分析第 ${index+1} / ${scanJobs.length} 个 · `:''}已完成 ${done}，失败 ${failed}`;
}
function renderScanProgress(){
  const done=scanJobs.filter(j=>j.state==='done').length,failed=scanJobs.filter(j=>j.state==='failed').length;
  const running=scanJobs.filter(j=>j.state==='running');
  const excluded=scanJobs.filter(j=>j.state==='done'&&(j.excluded||URLTools.searchResultReason(j.url))).length;
  const lines=[`已处理 ${done} / ${scanJobs.length} · 其中排除 ${excluded} · 失败 ${failed} · 同时分析 ${running.length} 个`];
  if(scanStopped)lines.push('正在停止等待；已保存的结果保留。');
  for(const job of running){
    const live=scanLive.get(job.url),index=scanJobs.indexOf(job)+1;
    lines.push(`第 ${index} / ${scanJobs.length} 个 · ${live?.stage||'准备分析'} · ${live?Math.floor((Date.now()-live.started)/1000):0} 秒\n${job.url}`);
  }
  $('scanStatus').textContent=lines.join('\n');
}
function updateScanStatus(jobs){
  scanJobs=jobs;renderScanProgress();
  if(typeof ahrefsGroups!=='undefined')renderAhrefs();
}
function scanEntries(rows,remaining){
  const byURL=new Map(scanJobs.map(job=>[job.url,job]));
  const plan=ResourcePolicy.plan(rows.map(row=>({...byURL.get(row.url),...row})),{limit:Number($('scanHostLimit').value)});
  $('scanPlan').textContent=`本次选取 ${plan.selected.length} 页；合并或暂缓 ${plan.skipped.length} 页（原始网址保留）。`;
  return plan.selected.map(row=>({url:URLTools.canonicalURL(row.url),remaining}));
}
// Bound every awaited operation, including Chrome APIs that may never settle.
function analysisBudget(stopped,totalMs=180000){
  const deadline=Date.now()+totalMs,controller=new AbortController();
  let failure;
  const stop=()=>stopped()||controller.signal.aborted;
  const run=(action,ms,label)=>new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;clearInterval(poll);clearTimeout(timer);fn(value);};
    const fail=message=>{failure=failure||Object.assign(Error(message),{analysisTimeout:!stopped(),fatal:true});controller.abort();finish(reject,failure);};
    const check=()=>{if(stop())fail(stopped()?'已停止分析':failure?.message||'分析已终止');else if(Date.now()>=deadline)fail('单网站分析超过 180 秒，已跳过');};
    const poll=setInterval(check,100);
    const remaining=deadline-Date.now();
    const timer=setTimeout(()=>fail(remaining<=ms?'单网站分析超过 180 秒，已跳过':label+'超时，已跳过'),Math.max(0,Math.min(ms,remaining)));
    check();if(settled)return;
    Promise.resolve().then(()=>{if(stop())throw failure||Error('已停止分析');return action();}).then(value=>{check();finish(resolve,value);},error=>finish(reject,error));
  });
  return {run,stopped:stop,signal:controller.signal,close:()=>controller.abort()};
}
async function visitBlog(url,isStopped){
  const excludedResult=(reason,finalUrl=url)=>({verdict:'unknown',excluded:true,reason,finalUrl,hasCommentForm:false,captcha:false,sites:[],linkMethods:[],linkSamples:[]});
  const initialReason=URLTools.searchResultReason(url);
  if(initialReason)return excludedResult(initialReason);
  let stage='正在加载网页';
  const started=Date.now();
  const progress=()=>{scanLive.set(url,{stage,started});renderScanProgress();};
  const timer=setInterval(progress,1000);progress();
  let tab;
  const budget=analysisBudget(isStopped);
  const limited=budget.run;
  try{
    tab=await limited(async()=>{const created=await chrome.tabs.create({url,active:false});if(budget.stopped()){chrome.tabs.remove(created.id).catch(()=>{});throw Error('已停止分析');}return created;},10000,'创建分析网页');
    let ready=false;
    for(let i=0;i<80;i++){
      if(isStopped())throw Error('已停止');
      const current=await limited(()=>chrome.tabs.get(tab.id),5000,'读取网页加载状态');
      const redirectReason=URLTools.searchResultReason(current.url);
      if(redirectReason)return excludedResult('来源页跳转到了'+redirectReason,current.url);
      if(current.status==='complete'){ready=true;break;}
      await nap(250);
    }
    if(!ready)throw Error('网页加载超时');
    await nap(1500);
    if(isStopped())throw Error('已停止');
    stage='正在读取评论与表单';progress();
    const initialPage=await limited(()=>readBlogPage(tab.id),15000,'读取评论与表单');
    if(!initialPage?.evidence)throw Error('无法读取页面证据');
    const finalReason=URLTools.searchResultReason(initialPage.url);
    if(finalReason)return excludedResult('来源页跳转到了'+finalReason,initialPage.url);
    const page=await limited(()=>collectCommentPages(tab.id,initialPage,budget.stopped,value=>{if(!budget.stopped()){stage=value;progress();}},limited),60000,'评论采集');
    const comments=`保存 ${page.items.length} 条评论；${page.commentCollection?.reason||''}`;
    if(isStopped())throw Error('已停止');
    let result;
    page.evidence.qualitySample={title:page.evidence.pageTitle||'',article:page.evidence.articleSample||'',
      comments:page.items.slice(0,30).map(item=>({text:(item.text||'').slice(0,600),links:(item.links||[]).slice(0,8)})),
      collectedComments:page.items.length,collection:page.commentCollection||null};
    stage='正在等待 Codex CLI 判断（单次最多 100 秒）';progress();
    try{result=await limited(()=>discoveryRequest('draft',{mode:'assess_blog',evidence:page.evidence},null,budget.signal),110000,'Codex 判断');}
    catch(error){if(!error.analysisTimeout&&!budget.stopped())error.bridgeFailure=true;throw error;}
    const verdict=commentEligibility(page.evidence,result.verdict);
    const quality=PageQuality.assess(page.evidence,result.quality);
    const origin=new URL(page.url).hostname.replace(/^www\./,'');
    const sites=[...new Set(page.items.flatMap(item=>item.sites).flatMap(raw=>{
      try{const value=URLTools.canonicalURL(raw);return URLTools.searchResultReason(value)||new URL(value).hostname.replace(/^www\./,'')===origin?[]:[value];}catch{return [];}
    }))];
    return {verdict,excluded:false,reason:verdict==='link_unverified'?'发现可留言表单，未发现登录或验证码要求；提交按钮可能等待填写必填项，提交和留链效果仍待验证。':String(result.reason||'').slice(0,300),captcha:page.evidence.forms.some(f=>f.captcha),
      topics:ResourceTopics.normalize(result.topics),quality,hasCommentForm:page.evidence.forms.length>0,frameCoverage:page.evidence.frameCoverage,formEvidence:page.evidence.forms,manualFillRequired:!page.evidence.forms.some(f=>f.comment&&f.submit&&!f.captcha&&f.website&&!f.custom&&!f.frameId),linkMethods:page.evidence.linkMethods||[],linkSamples:page.items.flatMap(item=>item.links||[]).slice(0,50),commentCollection:page.commentCollection,embeddedComments:page.evidence.embeddedComments,sites,comments,finalUrl:URLTools.canonicalURL(page.url)};
  }finally{budget.close();clearInterval(timer);scanLive.delete(url);if(tab)chrome.tabs.remove(tab.id).catch(()=>{});}
}
async function afterCollection(rows){
  const rounds=Number($('recursionRounds').value);
  if(!Number.isInteger(rounds)||rounds<0||rounds>5)throw Error('递归轮数须为 0–5；本次外链已保存。');
  await scanner.enqueue(scanEntries(rows,rounds));
  await runDiscovery();
}
async function runDiscovery(){
  return navigator.locks.request('blogDiscoveryWorkflow',{ifAvailable:true},async lock=>{
    if(!lock){$('scanStatus').textContent='另一个侧边栏正在分析，请在原窗口查看进度。';return;}
    scanStopped=false;$('stopDiscovery').hidden=false;
    try{
      if(!localStorage.getItem('codexBridgeToken'))throw Error('外链已保存并排队；请先启用 Codex CLI 桥接，再点继续分析。');
      // Check the adapter without spending a model request before the first article.
      $('scanStatus').textContent='正在检查本机桥接连接（不调用模型）……';
      const concurrency=Number($('scanConcurrency').value);
      if(!Number.isInteger(concurrency)||concurrency<1||concurrency>5)throw Error('并发数量须为 1–5。');
      const health=await discoveryRequest('health',{});
      if(concurrency>(health.capacity||1))throw Error('当前桥接仅支持 '+(health.capacity||1)+' 个并发；请重启新版桥接，或将并发数设为 1。');
      if(health.busy)throw Error('桥接仍在处理上一条请求，请等待终端结束后继续。');
      let retryFailed=true;
      while(!scanStopped){
        const result=await scanner.run({retryFailed,concurrency});retryFailed=false;
        if(result.stopped){scanStopped=true;break;}
        const tasks=(await chrome.storage.local.get(recursionKey))[recursionKey]||[];
        for(const job of result.selected||result.jobs){
          if(job.state!=='done'||!job.remaining)continue;
          for(const site of job.sites||[]){
            if(URLTools.searchResultReason(site))continue;
            const domain=new URL(site).hostname.replace(/^www\./,'');
            let task=tasks.find(t=>t.domain===domain);
            if(!task){task={domain,remaining:job.remaining-1,state:'pending'};tasks.push(task);}
            else task.remaining=Math.max(task.remaining,job.remaining-1);
          }
        }
        await chrome.storage.local.set({[recursionKey]:tasks});
        const task=tasks.find(t=>!URLTools.searchResultReason('https://'+t.domain+'/')&&(t.state!=='done'||(t.propagated??-1)<t.remaining));
        if(!task)break;
        if(scanStopped)break;
        $('scanStatus').textContent=`递归查询 ${task.domain}（后续还可扩展 ${task.remaining} 轮）……`;
        try{
          if(!task.rows){
            const report=await collectSemrush(task.domain,true);
            await saveCollected(report.target,report.rows);
            task.rows=report.rows;task.state='done';
            await chrome.storage.local.set({[recursionKey]:tasks});
          }
          if(scanStopped)break;
          await scanner.enqueue(scanEntries(task.rows,task.remaining));
          task.propagated=task.remaining;task.state='done';delete task.error;
          await chrome.storage.local.set({[recursionKey]:tasks});
        }catch(error){task.error=error.message;await chrome.storage.local.set({[recursionKey]:tasks});throw Error('递归已暂停：'+error.message);}
      }
      updateScanStatus(scanJobs);
      const lastError=[...scanJobs].reverse().find(job=>job.state==='failed')?.error;
      $('scanStatus').textContent+=scanStopped?' 已暂停。'+(lastError||'可点击继续分析。'):' 本轮分析与递归完成。';
    }catch(error){$('scanStatus').textContent=error.message;}
    finally{$('stopDiscovery').hidden=true;}
  });
}
function initDiscovery(){
  scanner=BlogQueue.create({
    select:jobs=>{
      const sources=new Map(uniqueCollected().map(row=>[row.url,row]));
      const plan=ResourcePolicy.plan(jobs.map(job=>({...sources.get(job.url),...job})),{limit:Number($('scanHostLimit').value)});
      const allowed=new Set(plan.selected.map(row=>row.url));
      $('scanPlan').textContent=`队列选取 ${allowed.size} 个代表页；${plan.skipped.length} 页不重复分析（历史结果和原始网址保留）。`;
      return jobs.filter(job=>allowed.has(job.url));
    },
    load:async()=>(await chrome.storage.local.get(scanKey))[scanKey]||[],
    save:jobs=>chrome.storage.local.set({[scanKey]:jobs}),visit:visitBlog,changed:updateScanStatus,
    lock:fn=>navigator.locks.request(scanKey,fn)
  });
  $('scanHostLimit').value=localStorage.getItem('scanHostLimit')||'3';
  $('scanHostLimit').onchange=()=>localStorage.setItem('scanHostLimit',$('scanHostLimit').value);
  $('scanConcurrency').value=localStorage.getItem('scanConcurrency')||'3';
  $('scanConcurrency').onchange=()=>localStorage.setItem('scanConcurrency',$('scanConcurrency').value);
  $('recursionRounds').value=localStorage.getItem('recursionRounds')||'0';
  $('recursionRounds').onchange=()=>localStorage.setItem('recursionRounds',$('recursionRounds').value);
  $('stopDiscovery').onclick=()=>{scanStopped=true;scanner.stop();$('scanStatus').textContent='正在停止等待；已保存的评论和结果保留。桥接中已启动的模型任务可能仍需自行结束。';};
  $('resumeDiscovery').onclick=()=>{
    if(busy)return;
    const permission=chrome.permissions.request({origins:['https://*/*','http://*/*']});
    run(async()=>{if(!await permission)throw Error('需要网页读取权限。');await runDiscovery();});
  };
  $('analyzeLibrary').onclick=()=>{
    if(busy)return;
    const permission=chrome.permissions.request({origins:['https://*/*','http://*/*']});
    run(async()=>{if(!await permission)throw Error('需要网页读取权限。');
      const rounds=Number($('recursionRounds').value);
      if(!Number.isInteger(rounds)||rounds<0||rounds>5)throw Error('递归轮数须为 0–5。');
      await scanner.enqueue(scanEntries([...ahrefsGroups.values()].flat(),rounds),{refresh:$('refreshEvidence').checked});await runDiscovery();});
  };
}
