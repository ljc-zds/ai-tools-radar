let libraryFilter='all', libraryRecords=new Map(), batchActive=false, batchStopped=false;
function libraryInfo(item){
  const job=scanJobs.find(j=>j.url===item.url),record=libraryRecords.get(item.url);
  const type=job?.hasCommentForm?'blog':item.title==='评论者公开网址（待验证）'?'profile':'unknown';
  let state='unknown',label=job?.state==='failed'?'分析失败':'未确认';
  if(job?.state==='done'){label=guestLabel(job.verdict);if(job.verdict==='likely_guest')state='ready';}
  if(job?.captcha){state='captcha';label='有验证码';}
  if(job?.state==='failed')state='failed';
  if(job?.excluded||URLTools.searchResultReason(item.url)){state='excluded';label='已排除：搜索结果页';}
  if(record&&record.state!=='candidate'){
    label=stateLabels[record.state]||record.state;
    state=record.state==='published'?'published':['submit_failed','submit_paused'].includes(record.state)?'failed':'locked';
  }
  return {job,record,type,state,label};
}
function matchesCollected(item){
  if(!LinkRisk.matches(item,$('spamFilter').value))return false;
  const info=libraryInfo(item);
  return libraryFilter==='all'||(['blog','profile'].includes(libraryFilter)?info.type===libraryFilter:info.state===libraryFilter);
}
function uniqueCollected(){
  const rows=new Map();
  for(const [website,links] of ahrefsGroups)for(const item of links){
    if(!rows.has(item.url))rows.set(item.url,{...item,targets:[]});
    rows.get(item.url).targets.push(website);
  }
  return [...rows.values()];
}
async function refreshLibraryRecords(){
  const productId=$('product').value;
  if(!productId){libraryRecords.clear();renderAhrefs();return;}
  const {records}=await api('/library-workflows',{productId});
  if(productId!==$('product').value)return;
  libraryRecords=new Map(records.map(row=>[row.url,row]));renderAhrefs();
}
function renderCollectedCards(){
  const panel=$('ahrefsGroups');panel.replaceChildren();
  const all=uniqueCollected(),rows=all.filter(matchesCollected);
  $('collectedCount').textContent=`共 ${rows.length} 条资源（已保存 ${all.length} 条）`;
  $('exportAhrefs').hidden=!all.length;
  for(const item of rows){
    const info=libraryInfo(item),row=document.createElement('div');row.className='library-card';
    const type=document.createElement('span');type.className='type-pill';type.textContent={blog:'博客评论',profile:'站长网址',unknown:'待识别'}[info.type];
    const url=document.createElement('a');url.href=item.url;url.textContent=item.url.replace(/^https?:\/\//,'');
    url.title=item.url+'\n来源目标：'+item.targets.join('、');url.onclick=e=>{e.preventDefault();openOnly(item.url);};
    const state=document.createElement('span');state.className='state-pill '+info.state;state.textContent=info.state==='ready'?'可发布':info.label;
    state.title=(info.job?.reason||'尚未分析')+'\n'+LinkRisk.labels[LinkRisk.classify(item)];
    const open=document.createElement('button');open.textContent='↗';open.title='打开网页';open.onclick=()=>openOnly(item.url);
    const remove=document.createElement('button');remove.textContent='×';remove.title='从资源库移除（保留提交记录）';
    remove.onclick=()=>run(async()=>{
      await navigator.locks.request(ahrefsStorageKey,async()=>{
        await loadAhrefsGroups();
        const groups=[...ahrefsGroups].map(([target,links])=>({target,links:links.filter(i=>i.url!==item.url)})).filter(g=>g.links.length);
        await chrome.storage.local.set({[ahrefsStorageKey]:groups});await loadAhrefsGroups();
      });renderAhrefs();
    });
    open.disabled=remove.disabled=busy;row.append(type,url,state,open,remove);panel.append(row);
    const details=document.createElement('details');details.className='link-evidence';
    const heading=document.createElement('summary');heading.textContent='查看留言方式与链接证据';details.append(heading);
    const text=document.createElement('p');
    const methods={website_field:'有网站地址字段',existing_body_links:'已有评论包含正文链接（不保证新评论允许）',embedded_form_manual:'嵌入式评论需人工处理'};
    text.textContent=(info.job?.linkMethods||[]).map(m=>methods[m]||m).join('；')||'留言方式尚未识别';
    if(info.job?.commentCollection)text.textContent+='。评论采集：'+info.job.commentCollection.reason;
    if(info.record?.linkCheck)text.textContent+='。提交核验：'+(info.record.linkCheck.found?'已找到目标链接（当前浏览器可见）':'未找到目标链接');
    details.append(text);
    const samples=info.record?.linkCheck?.links||info.job?.linkSamples||[];
    for(const sample of samples.slice(0,10)){const p=document.createElement('p');p.textContent=sample.url+' · rel: '+(sample.rel?.join(' ')||'未标注 nofollow/ugc/sponsored（不保证排名收益）');details.append(p);}
    panel.append(details);
  }
  for(const chip of $('libraryChips').querySelectorAll('button'))chip.setAttribute('aria-pressed',String(chip.dataset.filter===libraryFilter));
}
function initLibrary(){
  $('libraryChips').onclick=e=>{const chip=e.target.closest('button[data-filter]');if(chip){libraryFilter=chip.dataset.filter;renderAhrefs();}};
  $('exportCSV').onclick=()=>{
    const cell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
    const rows=uniqueCollected().filter(matchesCollected).map(item=>[item.url,item.targets.join(' | '),libraryInfo(item).label,LinkRisk.labels[LinkRisk.classify(item)]]);
    const data='\ufeff'+[['网址','来源目标','留言状态','SPAM 状态'],...rows].map(row=>row.map(cell).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='blog-resources.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
}
async function publishLibrary(){
  const domain=$('publishDomain').value.trim();
  const website=URLTools.canonicalURL(/^https?:\/\//i.test(domain)?domain:'https://'+domain);
  const host=new URL(website).hostname.replace(/^www\./,'');
  if(!host.includes('.')||/example\.(com|org|net)$/.test(host))throw Error('请填写你真实要推广的网站域名。');
  if(!localStorage.getItem('codexBridgeToken'))throw Error('请先在设置中启用 Codex CLI。');
  let selected=(await api('/products',{})).products.find(p=>new URL(p.url).hostname.replace(/^www\./,'')===host);
  if(!selected){
    const name=$('publisherName').value.trim(),email=$('publisherEmail').value.trim();
    if(!name||!/^\S+@\S+\.\S+$/.test(email))throw Error('首次发布此域名，请补充真实留言昵称和邮箱。');
    await LocalAPI.importProfile({product:{name:host,url:'https://'+host+'/',submitter:{name,email}},copy:{},compliance:{forbidden_claims_regex:[]}});
    await products();selected=(await api('/products',{})).products.find(p=>new URL(p.url).hostname.replace(/^www\./,'')===host);
  }
  const product=await api('/product-details',{productId:selected.id});
  if(!product.submitter.name||!/^\S+@\S+\.\S+$/.test(product.submitter.email)||/example\.(com|org|net)$/i.test(product.submitter.email))throw Error('此产品缺少真实昵称或邮箱，请在设置中导入完整产品资料。');
  $('product').value=selected.id;$('mode').value='blog';$('autoSubmit').checked=$('publishAction').value==='submit';$('events').checked=false;
  await refreshLibraryRecords();
  const limit=Number($('publishLimit').value);
  if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('每批发布数量须为 1–50。');
  // Resource filters are for browsing. Publishing always uses verified guest evidence and excludes known SPAM.
  const rows=uniqueCollected().filter(item=>libraryInfo(item).state==='ready'&&libraryInfo(item).type==='blog'&&LinkRisk.classify(item)!=='spam').slice(0,limit);
  if(!rows.length)throw Error('没有未处理的疑似免登录博客资源，请先收集并分析。');
  batchStopped=false;batchActive=true;busy=true;controls();$('stopPublish').hidden=false;
  try{
    for(let i=0;i<rows.length&&!batchStopped;i++){
      $('publishStatus').textContent=`正在发布 ${i+1} / ${rows.length}：${rows[i].url}`;
      await automation.openAuthorized(rows[i].url);
      await refreshLibraryRecords();
      const state=libraryRecords.get(rows[i].url)?.state;
      if(state==='published'&&libraryRecords.get(rows[i].url)?.linkCheck?.found===false){
        $('publishStatus').textContent='评论已显示，但未找到目标链接，本批暂停，请在网页核对。';return;
      }
      if($('publishAction').value==='review'){
        $('publishStatus').textContent=state==='filled'?'已填写一篇，请在网页检查后手动提交；本批暂停。':$('status').textContent;return;
      }
      if(!['published','pending_review'].includes(state)){
        $('publishStatus').textContent='批次已暂停：'+$('status').textContent;return;
      }
    }
    $('publishStatus').textContent=batchStopped?'已停止后续发布。':'本批处理完成；等待审核的评论不等于已发布。';
  }finally{batchActive=false;busy=false;$('stopPublish').hidden=true;controls();}
}
function initPublish(){
  $('publishLibrary').onclick=()=>{
    if(busy)return;
    const permission=chrome.permissions.request({origins:['https://*/*','http://*/*']});
    run(async()=>{if(!await permission)throw Error('需要访问资源网站的权限。');await publishLibrary();});
  };
  $('stopPublish').onclick=()=>{batchStopped=true;automation.cancel();};
}
