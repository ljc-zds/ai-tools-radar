(() => {
  const bounded = (value,max) => typeof value === 'string' && value.length <= max;
  const fail = message => { throw Error(message || 'URL 无效。'); };
  function canonicalURL(raw) {
    if (!bounded(raw, 4000) || !raw || /[\x00-\x20\\]/.test(raw)) fail('URL 无效。');
    const rawParts = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(raw);
    if (!rawParts || rawParts[2].includes('@')) fail('URL 无效。');
    let url; try { url = new URL(raw); } catch { fail('URL 无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /^#[/!]/.test(url.hash)) fail('URL 无效或不支持 hash 路由。');
    if (url.port === '0') fail('URL 端口无效。');
    const path = rawParts[3] || '/';
    if (/(?:token|password|secret|session|api[_-]?key|authorization)[=/]/i.test(path)) fail('URL 路径疑似包含凭据。');
    const pairs = [...url.searchParams]; if (pairs.length > 100) fail('URL 参数过多。');
    const search = [];
    const quotePlus = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
    for (const [key,value] of pairs.sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
      if (/token|password|passwd|secret|session|api.?key|auth|credential|cookie|email|nonce|signature|^code$/i.test(key)) fail('URL 查询参数疑似包含凭据。');
      if (key.length > 100 || value.length > 300) fail('URL 参数过长。');
      if (/^utm_/i.test(key) || ['fbclid','gclid','ref','referrer'].includes(key.toLowerCase())) continue;
      search.push(quotePlus(key) + '=' + quotePlus(value));
    }
    return url.protocol + '//' + url.host + path + (search.length ? '?' + search.join('&') : '');
  }
  function searchResultReason(raw) {
    try {
      const u=new URL(raw),host=u.hostname.toLowerCase(),path=u.pathname;
      if(!['http:','https:'].includes(u.protocol))return '';
      const yahoo=/(^|\.)search\.yahoo\.com$/.test(host);
      const google=/^(www\.)?google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(host)&&/^\/search\/?$/.test(path);
      const bing=/^(www\.|cn\.)?bing\.com$/.test(host)&&/^\/search\/?$/.test(path);
      const baidu=/^(www\.|m\.)?baidu\.com$/.test(host)&&/^\/(s|from)\/?$/.test(path);
      const duck=/^(www\.|html\.|lite\.)?duckduckgo\.com$/.test(host)&&u.searchParams.has('q');
      const yandex=/^(www\.)?yandex\.(com|ru)$/.test(host)&&/^\/search\/?$/.test(path);
      return yahoo||google||bing||baidu||duck||yandex?'搜索引擎结果页，不作为博客评论资源':'';
    } catch {return '';}
  }
  globalThis.URLTools = Object.freeze({canonicalURL,searchResultReason});
})();

// Scheduling/grouping identities are separate from stored URLs and submission ledger keys.
const ResourcePolicy={
  isAuthor(row){return row.resourceKinds?.includes('source')?false:row.resourceKinds?.includes('author')||row.resourceKind==='author'||row.title==='评论者公开网址（待验证）';},
  host(raw){return new URL(raw).hostname.toLowerCase().replace(/^www\./,'');},
  family(raw){
    const u=new URL(URLTools.canonicalURL(raw));
    u.pathname=u.pathname.replace(/\/(?:%20)+comment\/view\//i,'/comment/view/');
    const thread=u.pathname.match(/^(.*\/comment\/view\/\d+)(?:\/|$)/i);
    if(thread)return this.host(u.href)+thread[1];
    u.pathname=u.pathname.replace(/\/comment-page-\d+\/?$/i,'/');u.searchParams.delete('cpage');
    return this.host(u.href)+u.pathname+u.search;
  },
  group(rows){
    const groups=new Map();
    for(const row of rows){const key=this.family(row.url);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    return [...groups.values()];
  },
  plan(rows,{limit=3}={}){
    if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('同站最多分析数量须为 1–20。');
    const selected=[],skipped=[],families=new Set(),counts=new Map();
    const priority=row=>row.verdict==='likely_guest'?2:row.hasCommentForm?1:0;
    for(const row of [...rows].sort((a,b)=>priority(b)-priority(a))){
      let reason='';
      try{
        const host=this.host(row.url),family=this.family(row.url);
        if(this.isAuthor(row))reason='站长网址，仅作为发现线索';
        else if(URLTools.searchResultReason(row.url))reason='搜索结果页';
        else if(families.has(family))reason='同一文章的评论详情/分页';
        else if((counts.get(host)||0)>=limit)reason='达到同站分析上限';
        else{families.add(family);counts.set(host,(counts.get(host)||0)+1);selected.push(row);}
      }catch{reason='无效网址';}
      if(reason)skipped.push({url:row.url,reason});
    }
    return {selected,skipped};
  }
};
