/* Permission and cancellation boundary for one user-requested target. Submission is explicitly requested by the user. */
(() => {
 function create(callbacks){
  let generation=0,controller=null,paused=null,working=false;
  const sameURL=(a,b)=>{try{return new URL(a).href===new URL(b).href;}catch{return false;}};
  const status=message=>callbacks.status(message);
  const selected=()=>callbacks.selection();
  const pattern=raw=>{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol))throw Error('只支持 HTTP/HTTPS 目标。');return url.protocol+'//'+url.hostname+'/*';};
  function pause(value){paused=value;callbacks.paused(value);status(value.kind==='redirect'?`目标已跳转，${value.pin.filled?'可能已填写部分字段，请核对':'尚未填写'}。原地址：${value.pin.url}\n新地址：${value.url}\n请明确授权并继续，或取消。`:'找到多个匹配表单，已暂停。请在下方选择正确表单，再点击继续；尚未填写。');}
  function changed(pin,tab){const error=Error('目标地址已变化。');error.redirect={kind:'redirect',pin,url:tab.url};return error;}
  async function guard(pin){
   if(pin.id!==generation||pin.signal.aborted)throw Error('已取消自动填写；不会继续填写。');
   const value=selected();if(value.productId!==pin.productId||value.mode!==pin.mode)throw Error('产品或场景已变化，请重新开始。');
   let tab;try{tab=await chrome.tabs.get(pin.tabId);}catch{throw Error('目标标签页已关闭。');}
   if(pin.id!==generation||pin.signal.aborted)throw Error('已取消自动填写；不会继续填写。');
   const after=selected();if(after.productId!==pin.productId||after.mode!==pin.mode)throw Error('产品或场景已变化，请重新开始。');
   if(!sameURL(tab.url,pin.url))throw changed(pin,tab);
   return tab;
  }
  const delay=(ms,signal)=>new Promise((resolve,reject)=>{if(signal.aborted)return reject(Error('已取消。'));const timer=setTimeout(resolve,ms);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('已取消。'));},{once:true});});
  async function waitLoaded(pin){
   const deadline=Date.now()+20000;
   while(Date.now()<deadline){
    if(pin.signal.aborted||pin.id!==generation)throw Error('已取消自动填写。');
    const tab=await chrome.tabs.get(pin.tabId),url=tab.url||tab.pendingUrl;
    if(url&&/^https?:/.test(url)&&new URL(url).href!==new URL(pin.url).href)throw changed(pin,{url});
    if(tab.status==='complete'&&sameURL(url,pin.url))return tab;
    await delay(250,pin.signal);
   }throw Error('目标页面加载超时。请检查网页后重新开始，尚未填写。');
  }
  async function execute(pin,resumeForms){
   let listener;
   try{
    status('正在加载目标页面……');await waitLoaded(pin);await guard(pin);
    listener=(tabId,change)=>{if(tabId===pin.tabId&&change.url&&!sameURL(change.url,pin.url)){pin.redirect={kind:'redirect',pin,url:change.url};pin.controller.abort();}};
    chrome.tabs.onUpdated?.addListener(listener);
    if(!resumeForms){
     status('正在识别表单；动态表单最多等待 6 秒……');
     const deadline=Date.now()+6000;let last;
     while(true){
      await guard(pin);
      try{await callbacks.analyze(await chrome.tabs.get(pin.tabId),pin);break;}
      catch(error){if(error.redirect||pin.signal.aborted)throw error;last=error;if(Date.now()>=deadline)throw Error(last.message+' 未进行填写；验证码、登录或非标准表单请在网页手动处理。');await delay(300,pin.signal);}
     }
    }
    await guard(pin);
    const choice=callbacks.choose(resumeForms);
    if(choice.ambiguous){pause({kind:'forms',pin});return;}
    if(choice.error)throw Error(choice.error);
    callbacks.selectForm(choice.id);
    status('正在调用模型并生成草稿……');await callbacks.generate(pin.signal,pin);
    await guard(pin);
    status('正在校验并填写空白字段……');const result=await callbacks.fill(pin);pin.filled=result?.filled||0;
    await guard(pin);
    if(callbacks.submit){
     chrome.tabs.onUpdated?.removeListener(listener);listener=null;
     await callbacks.submit(pin,result);
    }
    callbacks.paused(null);paused=null;
   }catch(error){
    const redirect=pin.redirect||error.redirect;
    if(redirect&&pin.id===generation){
     if(pin.filled){paused=null;callbacks.paused(null);status('已填写 '+pin.filled+' 项，随后网页发生跳转。已停止，不会再次自动填写；请在原网页手动核对与提交。');return;}
     try{callbacks.canonicalURL(redirect.url);pause(redirect);}catch{status('跳转后的地址不适合自动填写（可能是登录或含凭据地址）。已停止；请在网页手动处理。');}
    }else if(pin.id===generation)status(pin.signal.aborted?'已取消自动填写；不会继续填写。':error.message||'自动填写失败，尚未提交。');
   }finally{
    if(listener)chrome.tabs.onUpdated?.removeListener(listener);
    if(pin.id===generation){working=false;callbacks.busy(false);}
   }
  }
  function launch(url,tabId=null,resumeForms=false,resourceUrl=null,activeTab=false){
   if(working){status('自动填写正在进行；可点击取消。');return;}
   if(!callbacks.ready())return;
   let permission;
   const selection=selected(),id=++generation;
   try{
    const browserURL=new URL(url).href;
    callbacks.canonicalURL(url);
    url=browserURL;
    // This call is synchronous within the resource/resume button click gesture.
    permission=activeTab?Promise.resolve(true):chrome.permissions.request({origins:[pattern(url)]});
   }catch{status('无法请求目标网站权限；请重新打开插件后重试。');return;}
   working=true;callbacks.busy(true);status('正在请求此目标网站的访问权限……');
   Promise.resolve(permission).then(async granted=>{
    if(id!==generation)return;
    if(!granted){status('未授权此网站，未打开或填写任何目标。请再次点击并允许访问。');working=false;callbacks.busy(false);return;}
    paused=null;callbacks.paused(null);const runController=new AbortController();controller=runController;
    try{
     if(tabId===null){callbacks.reset();const tab=await chrome.tabs.create({url,active:true});tabId=tab.id;}
     const pin={id,url,resourceUrl:resourceUrl||url,tabId,productId:selection.productId,mode:selection.mode,signal:runController.signal,controller:runController};
     await execute(pin,resumeForms);
    }catch(error){if(id===generation){status(error.message||'无法打开目标。');working=false;callbacks.busy(false);}}
   }).catch(()=>{if(id===generation){working=false;callbacks.busy(false);status('网站访问授权失败，未进行填写。');}});
  }
  return{
   open:url=>launch(url),
   current:()=>{
    if(working){status('自动填写正在进行；可点击取消。');return;}
    if(!callbacks.ready())return;
    // Opening the extension grants activeTab; this path uses that exact tab only.
    const lookupGeneration=++generation,lookupSelection=selected();
    chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>{
     if(lookupGeneration!==generation||working||lookupSelection.productId!==selected().productId||lookupSelection.mode!==selected().mode)return;
     if(!tab?.id||!/^https?:\/\//.test(tab.url||'')){status('请先打开一个普通 HTTP/HTTPS 网页，再点击插件图标。');return;}
     launch(tab.url,tab.id,false,null,true);
    }).catch(()=>{if(lookupGeneration===generation)status('无法读取当前网页，请在目标页点击插件图标后重试。');});
   },
   resume:()=>{if(!paused){status('没有等待继续的自动填写任务。');return;}const value=paused;if(value.pin.productId!==selected().productId||value.pin.mode!==selected().mode){status('产品或场景已变化，请重新开始。');return;}launch(value.kind==='redirect'?value.url:value.pin.url,value.pin.tabId,value.kind==='forms',value.pin.resourceUrl||value.pin.url);},
   cancel:()=>{generation++;controller?.abort();paused=null;working=false;callbacks.paused(null);callbacks.busy(false);status('已停止后续操作。已发出的提交无法撤回；结果未知的目标不会自动重试。');},
   guard,isCurrent:pin=>pin.id===generation&&!pin.signal.aborted&&selected().productId===pin.productId&&selected().mode===pin.mode,
  };
 }
 globalThis.AutoFill=Object.freeze({create});
})();
