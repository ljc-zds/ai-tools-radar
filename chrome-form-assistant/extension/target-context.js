let refreshCurrentWebsite=()=>{};
function websiteContext(raw){
  try{
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol))return null;
    const semrush=(url.hostname==='sem.3ue.co'||/(^|\.)semrush\.com$/i.test(url.hostname));
    const ahrefs=/(^|\.)ahrefs\.com$/i.test(url.hostname);
    const service=semrush?'semrush':ahrefs?'ahrefs':null;
    const report=semrush&&/^\/analytics\/backlinks\//.test(url.pathname)||ahrefs&&/^\/backlink-checker\/?$/.test(url.pathname);
    const value=service?(report?url.searchParams.get(semrush?'q':'input'):null):url.hostname;
    if(!value)return {service,domain:null,report:!!report};
    const target=new URL(/^https?:\/\//i.test(value)?value:'https://'+value);
    if(!['http:','https:'].includes(target.protocol)||target.username||target.password||!target.hostname.includes('.'))return null;
    return {domain:target.hostname,service,report:!!report};
  }catch{return null;}
}
async function activeWebsiteContext(){
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  return {tab,context:websiteContext(tab?.url)};
}
function initTargetContext(){
  let sequence=0;
  const manual=new Set();
  const ids=['ahrefsTarget','semrushTarget','publishDomain'];
  for(const id of ids)$(id).addEventListener('input',()=>manual.add(id));
  async function refresh(force=false){
    if(busy)return;
    const current=++sequence;
    try{
      const {context}=await activeWebsiteContext();
      if(current!==sequence||busy)return;
      if(force)manual.clear();
      for(const id of ids)if(!manual.has(id))$(id).value=context?.domain||'';
      $('detectedWebsite').textContent=context?.domain?'当前目标：'+context.domain+(context.report?'（来自报告）':'（来自当前网页）'):'当前页没有可识别的目标域名，可手动填写。';
    }catch{$('detectedWebsite').textContent='无法读取当前标签页，请点击扩展图标或手动填写。';}
  }
  refreshCurrentWebsite=refresh;
  $('detectWebsite').onclick=()=>refresh(true);
  chrome.tabs.onActivated?.addListener(()=>refresh());
  chrome.tabs.onUpdated?.addListener((id,change,tab)=>{if(tab?.active&&(change.url||change.status==='complete'))refresh();});
  refresh();
}
