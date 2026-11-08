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
