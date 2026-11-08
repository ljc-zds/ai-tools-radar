function readBlogEvidence(includeComments) {
  const shown = el => !!el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  const area = document.querySelector('#comments,.comments-area,#comment-section,[data-comments]') || document;
  const editorSelector = 'textarea,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"][aria-multiline="true"]';
  const editable = el => shown(el) && !el.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]') && !el.matches(':disabled,[readonly],[contenteditable="false"]');
  const describe = el => [el.name,el.id,el.placeholder,el.getAttribute('aria-label'),...(el.labels||[])].map(v=>v?.textContent||v||'').join(' ');
  const scopes = new Set();
  for (const editor of area.querySelectorAll(editorSelector)) {
    if (!editable(editor)) continue;
    const scope = editor.closest('form,[role="form"],#respond,.comment-form,[data-comment-form],.comment-editor') || editor.parentElement;
    if (area === document && !/comment|reply|respond|评论|留言|回复/i.test(describe(editor)+' '+scope.id+' '+scope.className+' '+scope.getAttribute('aria-label'))) continue;
    scopes.add(scope);
  }
  const forms = [...scopes].filter(shown);
  const article=document.querySelector('article .entry-content,article .post-content,.entry-content,article,main')?.cloneNode(true);
  article?.querySelectorAll('#comments,.comments-area,#comment-section,[data-comments],.comment-list,.commentlist,form,nav,script,style,iframe').forEach(el=>el.remove());
  const evidence = {
    forms: forms.slice(0,10).map(form=>{
      const allControls=[...form.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(shown);
      const controls=allControls.filter(editable);
      const submitControls=allControls.filter(el=>el.matches('button[type="submit"],input[type="submit"]') || /^(post|submit|send|publish)(\s+(a |your )?(comment|reply))?$|发表评论|提交评论|发布|发送|提交|回复|^(comentar|comentario|publicar|enviar|envoyer|publier|kommentar senden)$/i.test((el.textContent||el.value||el.getAttribute('aria-label')||'').trim()));
      const emptyRequired=[...form.querySelectorAll('input[required],textarea[required],[aria-required="true"]')].filter(editable).filter(el=>!(el.value||el.textContent||'').trim()).map(el=>describe(el).slice(0,120));
      const hints=(form.innerText||'').slice(0,4000);
      const bodyLinkMethods=[];
      const bodyLinksForbidden=/no links|links (?:are )?(?:not allowed|disabled)|不允许.{0,8}链接|禁止.{0,8}链接/i.test(hints);
      if(controls.some(el=>[el.getAttribute('aria-label'),el.title,el.textContent].some(value=>/^(insert |add )?link(?:\s|$)|插入链接|添加链接|enlace|lien|verknüpfung|ссылк/i.test((value||'').trim()))))bodyLinkMethods.push('link_toolbar');
      if(!/no links|links (?:are )?(?:not allowed|disabled)|不允许.{0,8}链接|禁止.{0,8}链接/i.test(hints)&&/(?:supports?|allows?|允许|支持)[^\n.]{0,60}(?:links|链接)|<a\s+href|\[.{1,30}\]\(https?:/i.test(hints))bodyLinkMethods.push('format_hint');
      return {
        comment:[...form.querySelectorAll(editorSelector)].some(editable),
        website:[...form.querySelectorAll('input')].some(el=>editable(el)&&(el.type==='url'||/website|homepage|网站|网址|\burl\b/i.test(describe(el)))),
        submit:submitControls.some(editable),
        submitPresent:submitControls.length>0,
        submitDisabled:submitControls.length>0&&!submitControls.some(editable),
        emptyRequired,
        editorEmpty:[...form.querySelectorAll(editorSelector)].filter(editable).every(el=>!(el.value||el.textContent||'').replace(/\uFEFF|\u200B/g,'').trim()),
        captcha:!!form.querySelector('[class*="captcha" i],[id*="captcha" i],[data-sitekey],iframe[src*="turnstile"]'),
        bodyLinkMethods, bodyLinks:!bodyLinksForbidden&&bodyLinkMethods.length>0, bodyLinksForbidden,
        custom:form.tagName!=='FORM'||[...form.querySelectorAll(editorSelector)].some(el=>el.tagName!=='TEXTAREA'),
      };
    }),
    notices:[...area.querySelectorAll('.must-log-in,.logged-in-as,.comment-notes,[class*="login" i]')].filter(shown)
      .map(el=>el.innerText.trim()).filter(text=>/log|sign|register|登录|注册/i.test(text)).slice(0,10).map(s=>s.slice(0,250)),
    embeddedComments:!!area.querySelector('iframe[src*="comment"],iframe[src*="disqus"],iframe[src*="jetpack"],iframe[src*="wordpress"]'),
    linkMethods:[],
    articleSample:(article?.textContent||'').replace(/\s+/g,' ').trim().slice(0,6000),
    pageTitle:document.title.slice(0,300),
  };
  if(evidence.forms.some(f=>f.website))evidence.linkMethods.push('website_field');
  if(evidence.embeddedComments)evidence.linkMethods.push('embedded_form_manual');
  const frames=[...document.querySelectorAll('iframe')].filter(shown).filter(el=>!el.closest('[hidden],[aria-hidden="true"]'))
    .filter(el=>!/doubleclick|googlesyndication|googleads|recaptcha|hcaptcha|turnstile|adsystem/i.test(el.src+' '+el.id+' '+el.title))
    .filter(el=>!!el.closest('#comments,.comments-area,#comment-section,[data-comments],#respond,.comment-form')||/comment|disqus|jetpack|wordpress|reply|评论|留言/i.test(el.src+' '+el.id+' '+el.name+' '+el.title))
    .map(el=>({url:el.hasAttribute('srcdoc')?'about:srcdoc':el.src||'about:blank',name:el.name||''}));
  const items=[];
  for (const el of area.querySelectorAll('.comment-body,[itemprop="comment"],.comment-list li.comment,.commentlist li.comment,.commentlist li.pingback')) {
    if (!shown(el) || el.matches('.pingback,.trackback')) continue;
    const content=el.querySelector(':scope > .comment-content,:scope > [itemprop="text"],:scope > .comment-text,:scope > .comment-body > .comment-content');
    if (!content || !shown(content)) continue;
    const authors=[...el.querySelectorAll('.comment-author a[href],a[rel~="external"].url,[itemprop="author"] a[href]')]
      .filter(a=>shown(a)&&a.closest('.comment-body,[itemprop="comment"],li.comment')===content.closest('.comment-body,[itemprop="comment"],li.comment'));
    const links=[...content.querySelectorAll('a[href]')].slice(0,20).flatMap(a=>{
      try{const u=new URL(a.href);if(!/^https?:$/.test(u.protocol))return [];
        return [{url:u.href,rel:a.rel.toLowerCase().split(/\s+/).filter(Boolean),text:a.textContent.trim().slice(0,120)}];
      }catch{return [];}
    });
    items.push({text:content.innerText.trim().slice(0,3000),sites:authors.slice(0,8).map(a=>a.href),links});
    if(items.length>=500)break;
  }
  const more=!!area.querySelector('.comment-navigation,.comment-pagination,a[href*="comment-page-"],a[href*="cpage="]');
  // Only links inside comments count, not article links or author profiles.
  if(items.some(item=>item.links.length)){
    evidence.linkMethods.push('existing_body_links');
    for(const form of evidence.forms){if(form.bodyLinksForbidden)continue;form.bodyLinks=true;form.bodyLinkMethods.push('existing_body_links');}
  }
  if(evidence.forms.some(f=>f.bodyLinks))evidence.linkMethods.push('comment_body_link');
  return {url:location.href,evidence,items:includeComments?items:[],more,frames,frameName:window.name};
}

// Activate only an empty comment editor. Never type, click submit or alter disabled controls.
async function prepareBlogEditor(){
  const area=document.querySelector('#comments,.comments-area,#comment-section,[data-comments],#respond,.comment-form');
  if(!area)return;
  const el=[...area.querySelectorAll('textarea[name="comment"],textarea#comment,[contenteditable="true"]')].find(e=>e.getClientRects().length&&!e.disabled&&!e.readOnly);
  if(!el||(el.value||el.textContent||'').trim())return;
  el.focus({preventScroll:true});el.click();
  await new Promise(resolve=>setTimeout(resolve,500));
}
// Inspect permitted iframe documents independently, without crossing DOM origin boundaries.
async function readBlogPage(tabId) {
  let results;
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:prepareBlogEditor}).catch(()=>{});
  try {results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:readBlogEvidence,args:[true]});}
  catch {
    // One inaccessible child must not discard readable sibling comment frames.
    const frames=await chrome.webNavigation?.getAllFrames({tabId}).catch(()=>[])||[];
    const attempts=await Promise.allSettled((frames.length?frames:[{frameId:0}]).map(f=>chrome.scripting.executeScript({target:{tabId,frameIds:[f.frameId]},func:readBlogEvidence,args:[true]})));
    results=attempts.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  }
  const top=results.find(r=>r.frameId===0)||results[0];
  if(!top?.result?.evidence)throw Error('无法读取页面证据');
  const selected=[top],seen=new Set([top.frameId]);
  for(let i=0;i<selected.length;i++)for(const descriptor of selected[i].result.frames||[]){
    const matches=results.filter(r=>!seen.has(r.frameId)&&(r.result?.url===descriptor.url||(descriptor.name&&r.result?.frameName===descriptor.name)));
    if(matches.length!==1)continue;
    selected.push(matches[0]);seen.add(matches[0].frameId);
  }
  const root=top.result;
  const forms=selected.flatMap(r=>(r.result.evidence.forms||[]).map(f=>({...f,frameId:r.frameId||0,frameUrl:r.result.url})));
  const notices=selected.flatMap(r=>r.result.evidence.notices||[]);
  return {...root,evidence:{...root.evidence,forms,notices,linkMethods:[...new Set(selected.flatMap(r=>r.result.evidence.linkMethods||[]))],
    frameCoverage:{read:selected.length-1,unread:Math.max(0,selected.reduce((n,r)=>n+(r.result.frames||[]).length,0)-(selected.length-1))}},
    items:selected.flatMap(r=>r.result.items||[])};
}
function guestEvidenceEligible(evidence){
  return !evidence.notices?.length && evidence.forms.some(f=>f.comment&&f.submit&&!f.captcha&&(f.website||f.bodyLinks));
}

function commentEligibility(evidence,modelVerdict){
  if(modelVerdict==='login_required')return 'login_required';
  if(evidence.notices?.length||evidence.forms.some(f=>f.captcha))return 'unknown';
  if(modelVerdict==='likely_guest'&&guestEvidenceEligible(evidence))return 'likely_guest';
  const candidate=evidence.forms.some(f=>f.comment&&!f.bodyLinksForbidden&&
    (f.submit&&(!f.website&&!f.bodyLinks) || f.submitDisabled&&f.submitPresent&&(f.editorEmpty||f.emptyRequired?.length)));
  return candidate?'link_unverified':'unknown';
}
