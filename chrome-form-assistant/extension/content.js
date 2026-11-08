(() => {
  if (globalThis.__manualFormAssistantV06) return;
  globalThis.__manualFormAssistantV06 = true;
  const uid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  const documentId = uid();
  let snapshot = null;
  const undo = [];
  const visible = el => !el.closest('[hidden],[aria-hidden="true"], [inert]') && !!(el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const unsafe = /password|passwd|csrf|token|captcha|credit|card.?number|cvv|iban|routing|social.?security|验证码|密码|支付|银行卡/i;
  const label = el => ([...(el.labels || [])].map(n => n.textContent).join(' ') || el.getAttribute('aria-label') || el.placeholder || el.name || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const eligible = el => /^(TEXTAREA|SELECT|INPUT)$/.test(el.tagName) && !el.disabled && !el.readOnly && visible(el) && (el.tagName !== 'INPUT' || /^(text|email|url|tel)$/.test(el.type)) && !unsafe.test([el.name, el.id, label(el), el.autocomplete].join(' '));
  const text = el => el.tagName === 'SELECT' ? el.value : el.value;
  const populated = el => el.tagName === 'SELECT' ? !!el.value && !el.selectedOptions[0]?.disabled && !/^(select|choose|请选择|选择)/i.test(el.selectedOptions[0]?.textContent.trim() || '') : !!text(el).trim();
  function scan() {
    const forms = [...document.querySelectorAll('form')].filter(visible);
    if (!forms.length) throw Error('未找到普通 HTML 表单；第一版暂不支持富文本或 iframe。');
    const groups = [];
    const nodes = new Map();
    for (const form of forms) {
      const formText = ((form.getAttribute('aria-label') || '') + ' ' + form.id + ' ' + form.className + ' ' + [...form.querySelectorAll('button,input[type=submit]')].map(n => n.textContent || n.value).join(' ')).slice(0, 1200);
      if (form.querySelector('input[type=password],input[autocomplete="cc-number"],input[autocomplete="one-time-code"]') || /log.?in|sign.?in|search|checkout|payment|登录|搜索|结账|付款/i.test(formText)) continue;
      const fields = [...form.elements].filter(eligible).slice(0, 40).map(el => {
        const id = 'f' + nodes.size; nodes.set(id, {el, form, signature: signature(el)});
        return {id, label: label(el), type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type, required: el.required, maxLength: el.maxLength > 0 ? Math.min(el.maxLength, 6000) : 6000, populated: populated(el), options: el.tagName === 'SELECT' ? [...el.options].slice(0, 200).filter(o => !o.disabled).map(o => ({value: o.value.slice(0, 300), label: o.textContent.trim().slice(0, 200)})) : []};
      });
      if (fields.length) groups.push({hasCaptcha: !!form.querySelector('[data-sitekey],.g-recaptcha,.h-captcha,iframe[src*="captcha"],textarea[name*="recaptcha"],input[name*="captcha"]'), id: 'form' + groups.length, label: (formText.trim() || '表单') .slice(0, 100), fields});
    }
    if (!groups.length) throw Error('未找到安全可填写的表单；登录、搜索、支付和凭据表单已排除。');
    const article = document.querySelector('article') || document.querySelector('main,.entry-content,.post-content,.article-content') || document.body;
    let body = '';
    if (article) {
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      while (walker.nextNode() && body.length < 18000) {
        const p = walker.currentNode.parentElement;
        if (p && !p.closest('form,input,textarea,select,script,style,nav,header,footer,[contenteditable],[hidden],[aria-hidden="true"]') && visible(p)) body += walker.currentNode.textContent.trim() + ' ';
      }
    }
    const result = {documentId, snapshotId: uid(), url: location.origin + location.pathname, title: document.title.slice(0, 300), language: document.documentElement.lang.slice(0, 30), body: body.slice(0, 18000), groups};
    snapshot = {result, nodes, href: location.href};
    return result;
  }
  function signature(el) { return [el.tagName, el.type, el.name, el.id, label(el), el.maxLength, el.required, el.disabled, el.readOnly, el.tagName === 'SELECT' ? [...el.options].map(o => [o.value,o.textContent,o.disabled]) : ''].join('|'); }
  function fill(payload) {
    if (!snapshot || payload.documentId !== documentId || payload.snapshotId !== snapshot.result.snapshotId || snapshot.href !== location.href) throw Error('页面已变化，请重新分析。');
    const group = snapshot.result.groups.find(g => g.id === payload.formId);
    if (!group || !Array.isArray(payload.values) || payload.values.length > 40) throw Error('填写方案无效。');
    const seen = new Set();
    const entries = payload.values.map(item => {
      const field = group.fields.find(f => f.id === item.id), node = snapshot.nodes.get(item.id);
      if (!field || !node || seen.has(item.id) || typeof item.value !== 'string' || item.value.length > field.maxLength) throw Error('字段校验失败，请重新分析。');
      seen.add(item.id);
      if (!node.el.isConnected || !node.form.isConnected || node.el.form !== node.form || signature(node.el) !== node.signature || !eligible(node.el)) throw Error('表单结构已变化，请重新分析。');
      if (field.type === 'select' && !field.options.some(o => o.value === item.value)) throw Error('选项无效。');
      if (field.type === 'email' && item.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.value)) throw Error('邮箱格式无效。');
      if (field.type === 'url' && item.value && !/^https?:\/\//i.test(item.value)) throw Error('网址格式无效。');
      return {field, node, value: item.value};
    });
    let filled = 0, skipped = 0, aborted = false;
    for (const [index, {node, value}] of entries.entries()) {
      const el = node.el;
      if (!value || populated(el)) { skipped++; continue; }
      if (!el.isConnected || !node.form.isConnected || el.form !== node.form || !eligible(el) || snapshot.href !== location.href || signature(el) !== node.signature) { skipped += entries.length - index; aborted = true; break; }
      const previous = el.value;
      const record = {el, previous, applied: value, href: location.href, emitEvents: payload.emitEvents === true, trackingId: typeof payload.trackingId === 'string' ? payload.trackingId.slice(0, 80) : null, ledgerContext: payload.ledgerContext && typeof payload.ledgerContext.productId === 'string' && /^[a-f0-9]{64}$/.test(payload.ledgerContext.productId) && typeof payload.ledgerContext.url === 'string' && payload.ledgerContext.url.length <= 4000 ? {productId: payload.ledgerContext.productId, url: payload.ledgerContext.url} : null};
      undo.push(record);
      const prototype = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
      if (record.emitEvents) {
        el.dispatchEvent(new Event('input', {bubbles: true}));
        el.dispatchEvent(new Event('change', {bubbles: true}));
      }
      if (el.value === value) filled++;
    }
    return {filled, skipped, aborted};
  }
  function restore() {
    let restored = 0, skipped = 0;
    const trackingIds = new Set();
    const ledgerContexts = new Map();
    while (undo.length) {
      const item = undo.pop();
      if (item.trackingId) trackingIds.add(item.trackingId);
      if (item.ledgerContext) ledgerContexts.set(item.ledgerContext.productId + item.ledgerContext.url, item.ledgerContext);
      if (!item.el.isConnected || item.href !== location.href || item.el.value !== item.applied) { skipped++; continue; }
      const proto = item.el.tagName === 'SELECT' ? HTMLSelectElement.prototype : item.el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(item.el, item.previous);
      if (item.emitEvents) {
        item.el.dispatchEvent(new Event('input', {bubbles: true}));
        item.el.dispatchEvent(new Event('change', {bubbles: true}));
      }
      restored++;
    }
    return {restored, skipped, trackingIds: [...trackingIds], ledgerContexts: [...ledgerContexts.values()]};
  }
  let submitTicket = null, submissionStarted = false;
  const normalize = value => String(value||'').replace(/\s+/g,' ').trim();
  const challengeSelector = '[data-sitekey],.g-recaptcha,.h-captcha,.cf-turnstile,iframe[src*="captcha"],iframe[src*="challenges.cloudflare"],textarea[name*="recaptcha"],input[name*="captcha"]';
  function gate(form) {
    if(document.querySelector(challengeSelector))return '检测到验证码，已暂停，请在网页手动处理。';
    if([...document.querySelectorAll('input[type=password]')].some(visible)||/\/wp-login\.php|\/login(?:[/?#]|$)|\/signin(?:[/?#]|$)/i.test(location.href))return '检测到登录页面，已暂停。';
    if(form && (form.querySelector('input[type=password],input[autocomplete="cc-number"]') || [...form.querySelectorAll('input[type=checkbox]')].some(el=>el.required&&!el.checked)))return '表单包含登录、支付或未确认的必选项，已暂停。';
    return '';
  }
  function submitForm(payload) {
    if(!snapshot||payload.documentId!==documentId||payload.snapshotId!==snapshot.result.snapshotId||snapshot.href!==location.href)throw Error('提交前页面已变化，已暂停。');
    const group=snapshot.result.groups.find(g=>g.id===payload.formId);
    const form=group&&snapshot.nodes.get(group.fields[0]?.id)?.form;
    if(!form?.isConnected||!visible(form))throw Error('原表单已变化，已暂停。');
    return form;
  }
  function submitButton(form) {
    const buttons=[...form.elements].filter(el=>el.form===form&&visible(el)&&!el.disabled&&((el.tagName==='BUTTON'&&el.type==='submit')||(el.tagName==='INPUT'&&el.type==='submit')));
    if(buttons.length!==1)throw Error('提交按钮不唯一，已暂停。');
    const button=buttons[0],caption=normalize(button.textContent||button.value);
    if(!/post|submit|send|publish|comment|reply|enviar|publicar|提交|发布|发送/i.test(caption)||/pay|buy|subscribe|register|delete|purchase|支付|购买|注册|订阅|删除/i.test(caption))throw Error('未找到明确的评论或目录提交按钮，已暂停。');
    const action=new URL(button.getAttribute('formaction')||form.getAttribute('action')||location.href,location.href);
    if(action.origin!==location.origin)throw Error('表单提交到其他网站，已暂停。');
    return button;
  }
  const commentNodes=()=>[...document.querySelectorAll('[id^="div-comment-"],article.comment,.comment-body')];
  const noticeNodes=()=>[...document.querySelectorAll('.comment-awaiting-moderation,#error-page,.wp-die-message,.comment-form .error,#commentform .error,[role=alert],.submission-message,.success-message')].filter(visible);
  function prepareSubmit(payload) {
    const form=submitForm(payload),reason=gate(form);if(reason)throw Error(reason);
    if(submissionStarted)throw Error('本页已经发起提交，禁止重复提交。');
    if(!form.checkValidity())throw Error('必填项或格式校验未通过，已暂停。');
    const button=submitButton(form);
    const body=normalize(form.querySelector('textarea')?.value);
    if(body.length<20)throw Error('内容不足，已暂停自动提交。');
    const website=[...form.elements].find(el=>el.type==='url'||/^(url|website)$/i.test(el.name));
    const websiteValue=website?.value||'';
    if(commentNodes().some(node=>normalize(node.innerText).includes(body)|| (websiteValue && [...node.querySelectorAll('a[href]')].some(a=>{try{return new URL(a.href).hostname===new URL(websiteValue).hostname;}catch{return false;}}))))throw Error('评论区已有相同内容或产品网站，已阻止重复提交。');
    const values=[...form.elements].map(el=>[el,el.value,el.checked]);
    submitTicket={id:uid(),form,button,values,action:form.action,buttonAction:button.getAttribute('formaction'),method:form.method};
    return {ticket:submitTicket.id,probe:{body,website:websiteValue,mode:payload.mode,sourcePath:location.pathname,notices:noticeNodes().map(el=>normalize(el.innerText)),baseline:commentNodes().map(node=>node.id).filter(Boolean)}};
  }
  function submitOnce(payload) {
    try {
      const form=submitForm(payload),reason=gate(form);if(reason)throw Error(reason);
      const ticket=submitTicket;
      if(submissionStarted||!ticket||ticket.id!==payload.ticket||ticket.form!==form)throw Error('提交凭据已过期或已使用，已暂停。');
      if(ticket.button!==submitButton(form)||ticket.action!==form.action||ticket.buttonAction!==ticket.button.getAttribute('formaction')||ticket.method!==form.method||ticket.values.some(([el,value,checked])=>!el.isConnected||el.form!==form||el.value!==value||el.checked!==checked)||!form.checkValidity())throw Error('提交前表单内容或目标变化，已暂停。');
      submissionStarted=true;submitTicket=null;
      ticket.button.click();
      return {clicked:true};
    }catch(error){return {paused:true,reason:error.message};}
  }
  function submissionResult(probe) {
    const blocked=gate();if(blocked)return {state:'submit_paused',evidence:blocked};
    const unknown={state:'outcome_unknown',evidence:'未找到明确提交回执或对应评论；已锁定，禁止自动重试。'};
    if(!probe||typeof probe.body!=='string'||probe.body.length<20)return unknown;
    // Match full submitted content only inside a comment, never the editor or article.
    const matched=commentNodes().find(node=>visible(node)&&normalize(node.innerText).includes(probe.body)&&(!node.id||!probe.baseline.includes(node.id)));
    if(matched){
      if(matched.querySelector('.comment-awaiting-moderation')||/awaiting moderation|pending approval|aguardando modera|等待审核/i.test(matched.innerText))return {state:'pending_review',evidence:'对应评论显示等待审核，尚未公开。'};
      if(location.pathname===probe.sourcePath&&!new URLSearchParams(location.search).has('unapproved')){
        const links=[...matched.querySelectorAll('a[href]')].flatMap(a=>{
          try{
            const expected=new URL(probe.website),actual=new URL(a.href);expected.hash='';actual.hash='';
            if(!/^https?:$/.test(actual.protocol)||actual.href!==expected.href)return [];
            return [{url:actual.href,rel:a.rel.toLowerCase().split(/\s+/).filter(Boolean)}];
          }catch{return [];}
        }).slice(0,10);
        return {state:'published',linkCheck:{found:links.length>0,links,visibility:'current_browser'},
          evidence:'对应评论在当前浏览器可见；公开性未单独核验。'+(links.length?'已找到目标链接，记录 rel 属性。':'未发现目标链接，不能认定外链成功。')};
      }
    }
    const notices=noticeNodes().map(el=>normalize(el.innerText)).filter(t=>!(probe.notices||[]).includes(t));
    if(probe.mode==='directory'&&notices.some(t=>/(your (listing|site|submission)|您.*(网站|提交)).*(received|submitted|review|收到|审核)/i.test(t)))return {state:'pending_review',evidence:'网站明确确认收到目录提交；尚未确认公开发布。'};
    if(notices.some(t=>/must be logged|log in to|login required|必须登录|请先登录/i.test(t)))return {state:'submit_paused',evidence:'网站要求登录，已暂停。'};
    if(notices.some(t=>/your comment.*(awaiting|moderation|approval)|comment.*submitted.*approval|评论.*等待审核/i.test(t)))return {state:'pending_review',evidence:'网站明确提示评论等待审核。'};
    if(notices.some(t=>/duplicate comment|already.*(posted|submitted)|重复评论/i.test(t)))return {state:'submit_failed',evidence:'网站提示重复评论，已锁定，禁止再次提交。'};
    if(notices.some(t=>/error|failed|required|invalid|错误|失败|必填/i.test(t)))return {state:'submit_failed',evidence:'网站显示提交错误，请在原页面检查。'};
    return unknown;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    try {
      if (message.kind === 'analyze') respond({ok: true, data: scan()});
      else if (message.kind === 'prepareSubmit') respond({ok:true,data:prepareSubmit(message.payload)});
      else if (message.kind === 'submit') respond({ok:true,data:submitOnce(message.payload)});
      else if (message.kind === 'submissionResult') respond({ok:true,data:submissionResult(message.payload)});
      else if (message.kind === 'fill') respond({ok: true, data: fill(message.payload)});
      else if (message.kind === 'undo') { if(message.payload?.documentId && message.payload.documentId!==documentId)throw Error('原填写文档已变化，无法撤销。'); respond({ok: true, data: restore()}); }
    } catch (error) { respond({ok: false, error: error.message}); }
  });
})();
