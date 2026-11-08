function readBlogEvidence(includeComments) {
  const shown = el => !!el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  const area = document.querySelector('#comments,.comments-area,#comment-section,[data-comments]') || document;
  const forms = [...area.querySelectorAll('form')].filter(shown).filter(form =>
    form.matches('#commentform,.comment-form') || [...form.querySelectorAll('textarea')].some(el =>
      /comment|评论/i.test(el.name+' '+el.id+' '+[...(el.labels||[])].map(label=>label.textContent).join(' '))));
  const evidence = {
    forms: forms.slice(0,5).map(form=>({
      comment:[...form.querySelectorAll('textarea')].some(el=>shown(el)&&!el.matches(':disabled,[readonly]')),
      website:[...form.querySelectorAll('input')].some(el=>shown(el)&&!el.matches(':disabled,[readonly]')&&
        /website|homepage|网站|网址|^url$/i.test(el.name || el.id || el.placeholder)),
      submit:[...form.querySelectorAll('button[type="submit"],input[type="submit"],button:not([type])')].some(el=>shown(el)&&!el.matches(':disabled')),
      captcha:!!form.querySelector('[class*="captcha" i],[id*="captcha" i],iframe[src*="turnstile"]')
    })),
    notices:[...area.querySelectorAll('.must-log-in,.logged-in-as,.comment-notes,[class*="login" i]')].filter(shown)
      .map(el=>el.innerText.trim()).filter(text=>/log|sign|register|登录|注册/i.test(text)).slice(0,10).map(s=>s.slice(0,250)),
    embeddedComments:!!area.querySelector('iframe[src*="comment"],iframe[src*="disqus"],iframe[src*="jetpack"],iframe[src*="wordpress"]'),
    linkMethods:[],
  };
  if(evidence.forms.some(f=>f.website))evidence.linkMethods.push('website_field');
  if(evidence.embeddedComments)evidence.linkMethods.push('embedded_form_manual');
  if (!includeComments) return {url:location.href,evidence};
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
  if(items.some(item=>item.links.length))evidence.linkMethods.push('existing_body_links');
  return {url:location.href,evidence,items,more};
}
