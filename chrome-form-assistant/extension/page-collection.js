// Only explicit pagination/comment-reading controls, never form submission controls.
function advanceCollection(kind){
  const shown=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility==='visible';
  const enabled=el=>shown(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&!el.closest('[disabled],[aria-disabled="true"]');
  const caption=el=>(el.getAttribute('aria-label')||el.getAttribute('title')||el.innerText||'').trim();
  if(kind==='semrush'){
    if(!/^(sem\.3ue\.co|(?:[\w-]+\.)*semrush\.com)$/.test(location.hostname)||!location.pathname.startsWith('/analytics/backlinks/'))return {reason:'已离开 Semrush 报告'};
    const candidates=[...document.querySelectorAll('button,a[rel="next"],[role="button"]')].filter(enabled).filter(el=>!el.closest('form')&&/^(next(?: page)?|下一页|下一頁)$/i.test(caption(el)));
    if(candidates.length!==1)return {reason:candidates.length?'分页按钮不唯一，已暂停':'未发现可用的下一页按钮'};
    const next=candidates[0];
    if(next.tagName==='A'){
      const u=new URL(next.href);if(u.origin!==location.origin||!u.pathname.startsWith('/analytics/backlinks/')||u.searchParams.get('q')!==new URL(location.href).searchParams.get('q'))return {reason:'分页链接与查询目标不一致'};
    }
    next.click();return {advanced:true};
  }
  const area=document.querySelector('#comments,.comments-area,#comment-section,[data-comments]');
  const expansion=[...(area||document).querySelectorAll('button,[role="button"]')].filter(enabled).filter(el=>!el.closest('form')&&
    /^(show(?: all)? comments|load more comments|more comments|view(?: all)? comments|显示评论|展开评论|加载更多评论|更多评论|查看全部评论)$/i.test(caption(el)));
  if(expansion.length===1){expansion[0].click();return {advanced:true,kind:'expand'};}
  if(!area)return {reason:'未发现可展开的标准评论区'};
  const article=raw=>{const u=new URL(raw);u.pathname=u.pathname.replace(/\/comment-page-\d+\/?$/i,'/');u.searchParams.delete('cpage');u.hash='';return u.href;};
  const candidates=[...area.querySelectorAll('.comment-navigation a,.comment-pagination a,a[href*="comment-page-"],a[href*="cpage="]')].filter(enabled).filter(el=>{
    try{return new URL(el.href).origin===location.origin&&article(el.href)===article(location.href)&&el.href!==location.href&&
      /older|next|previous|较早|更早|上一页|下一页|下一頁/i.test(caption(el));}catch{return false;}
  });
  const next=candidates.find(el=>/older|更早|较早/i.test(caption(el)))||candidates.find(el=>/next|下一/i.test(caption(el)))||candidates[0];
  if(!next)return {reason:'未发现同一文章的评论分页'};
  next.click();return {advanced:true,kind:'page'};
}

const PageCollection={
  async run({first,read,advance,signature,save,maxPages,stopped=()=>false,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
    if(!Number.isInteger(maxPages)||maxPages<1||maxPages>20)throw Error('采集页数须为 1–20。');
    const seen=new Set();let page=first,count=0,reason='达到设置的采集页数';
    while(count<maxPages){
      if(stopped()){reason='已停止';break;}
      const key=signature(page);
      if(seen.has(key)){reason='重复页面，已停止翻页';break;}
      seen.add(key);await save(page,++count);
      if(count>=maxPages)break;
      const action=await advance();
      if(!action?.advanced){reason=action?.reason||'没有更多可识别的页面';break;}
      let next=null,stableKey=null;
      for(let attempt=0;attempt<24&&!stopped();attempt++){
        await wait(500);
        try{
          const candidate=await read(),candidateKey=signature(candidate);
          if(!candidateKey||candidateKey===key)continue;
          if(candidateKey===stableKey){next=candidate;break;}
          stableKey=candidateKey;
        }catch(error){if(error.fatal)throw error;}
      }
      if(!next){reason=stopped()?'已停止':'翻页后未读到稳定的新内容';break;}
      page=next;
    }
    return {pages:count,reason};
  }
};

let collectionStopped=false;
async function collectReportPages(tabId,first,recursive){
  const rows=new Map();let added=0,lastSaved;
  const read=async()=>{
    const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:readSemrushReport});
    if(result?.error||result?.target?.toLowerCase()!==first.target.toLowerCase()){
      const error=Error(result?.error||'翻页后查询目标发生变化');error.fatal=true;throw error;
    }
    if(!result.rows?.length)throw Error('正在加载');return result;
  };
  let metadata;
  try{
    metadata=await PageCollection.run({first,read,maxPages:Number($('reportPageLimit').value),
      stopped:()=>recursive?scanStopped:collectionStopped,
      signature:page=>JSON.stringify(page.rows.map(row=>row.url).sort()),
      advance:async()=>{const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:advanceCollection,args:['semrush']});return result;},
      save:async(page,count)=>{
        page.rows.forEach(row=>rows.set(row.url,row));
        lastSaved=await saveCollected(page.target,page.rows);added+=lastSaved.added;
        $('discoveryStatus').textContent=`已保存第 ${count} 页，累计 ${rows.size} 条来源页……`;
      }});
  }catch(error){if(!rows.size)throw error;metadata={reason:'采集暂停：'+error.message};}
  return {...first,rows:[...rows.values()],capture:{...metadata,added,total:lastSaved?.total||0}};
}

async function collectCommentPages(tabId,first,isStopped,onStage){
  const all=new Map();let metadata;
  const read=async()=>{
    const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:readBlogEvidence,args:[true]});
    if(!result?.items)throw Error('评论尚未加载');return result;
  };
  try{
    metadata=await PageCollection.run({first,read,maxPages:Number($('commentPageLimit').value),stopped:isStopped,
      signature:page=>JSON.stringify(page.items.map(item=>[item.text,item.sites])),
      advance:async()=>{const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:advanceCollection,args:['comments']});return result;},
      save:async(page,count)=>{
        page.items.forEach(item=>all.set(JSON.stringify([item.text,item.sites]),item));
        await saveBlogComments(page);onStage(`已保存 ${count} 页/批评论，累计 ${all.size} 条`);
      }});
  }catch(error){metadata={reason:'评论采集暂停：'+error.message};}
  const methods=new Set(first.evidence?.linkMethods||[]);
  if([...all.values()].some(item=>item.links?.length))methods.add('existing_body_links');
  return {...first,evidence:{...first.evidence,linkMethods:[...methods]},items:[...all.values()],commentCollection:metadata};
}
