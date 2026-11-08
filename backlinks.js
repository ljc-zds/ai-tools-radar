(() => {
  const $ = id => document.getElementById(id);
  const key = 'radar.backlinks.v1';
  const canonical = URLTools.canonicalURL;
  let groups = new Map();
  const status = text => { $('status').textContent = text; };
  function normalizeTarget(raw) {
    const text = raw.trim();
    const url = new URL(canonical(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text));
    if (!url.hostname.includes('.')) throw Error('请输入有效的网站域名或网址。');
    return url.href;
  }
  function merge(next, target, rows) {
    const links = new Map((next.get(target) || []).map(row => [row.url, row]));
    let added = 0, rejected = 0;
    for (const row of rows) {
      try {
        const url = canonical(typeof row === 'string' ? row.trim() : row.url_from || row.u || row.url);
        if (url === canonical(target)) { rejected++; continue; }
        if (!links.has(url)) {
          const title = row.title || row.title_from || row.s;
          links.set(url, {url, title: typeof title === 'string' ? title.slice(0, 300) : ''});
          added++;
        }
      } catch { rejected++; }
    }
    if (links.size) next.set(target, [...links.values()]);
    return {added, rejected};
  }
  function render() {
    $('groups').replaceChildren();
    $('export').disabled = !groups.size;
    for (const [target, links] of groups) {
      const box = document.createElement('details');
      box.open = true;
      const heading = document.createElement('summary');
      heading.textContent = target + ' · ' + links.length + ' 条来源页';
      const list = document.createElement('ol');
      for (const row of links) {
        const item = document.createElement('li');
        const anchor = document.createElement('a');
        anchor.href = row.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.textContent = row.title ? row.title + ' — ' + row.url : row.url;
        item.append(anchor);
        list.append(item);
      }
      box.append(heading, list);
      $('groups').append(box);
    }
  }
  function add(target, rows) {
    const next = new Map(groups);
    const result = merge(next, target, rows);
    try { localStorage.setItem(key, JSON.stringify([...next])); }
    catch { throw Error('浏览器存储不可用或已满，未保存本次结果。'); }
    groups = next;
    render();
    status('新增 ' + result.added + ' 条；跳过无效或指向目标自身的来源 ' + result.rejected + ' 条。重复网址不重复添加。');
  }
  try {
    for (const [target, rows] of JSON.parse(localStorage.getItem(key) || '[]')) {
      if (Array.isArray(rows)) merge(groups, normalizeTarget(target), rows);
    }
  } catch { status('无法读取部分已保存的外链。'); }
  render();
  $('collect').onsubmit = event => {
    event.preventDefault();
    try {
      const target = normalizeTarget($('target').value);
      const raw = $('sources').value.trim();
      if (!raw) throw Error('请先粘贴来源网址或 JSON。');
      const value = /^[\[{]/.test(raw) ? JSON.parse(raw) : raw.split(/\r?\n/).filter(line => line.trim());
      const rows = Array.isArray(value) ? value : value.backlinks || value.items;
      if (!Array.isArray(rows) || rows.length > 5000) throw Error('请提供有效来源列表，每批最多 5000 条。');
      add(target, rows);
    } catch (error) { status(error.message); }
  };
  $('lookup').onclick = async () => {
    $('lookup').disabled = true;
    try {
      const target = normalizeTarget($('target').value);
      const hostname = new URL(target).hostname;
      status('正在读取本地快照……');
      const indexResponse = await fetch('data/links/index.json');
      if (!indexResponse.ok) throw Error('本地快照读取失败，请通过项目的 HTTP 服务打开。');
      const domains = await indexResponse.json();
      const domain = [hostname, hostname.replace(/^www\./, '')].find(value => domains.includes(value));
      if (!domain) throw Error('本地快照未收录该域名，可用 Ahrefs 查询后粘贴来源页。');
      const response = await fetch('data/links/' + encodeURIComponent(domain) + '.json');
      if (!response.ok) throw Error('无法读取该域名的快照。');
      // A domain snapshot describes the entire domain, not an individual target page.
      add('https://' + domain + '/', await response.json());
    } catch (error) { status(error.message); }
    finally { $('lookup').disabled = false; }
  };
  $('export').onclick = () => {
    const items = [...groups].flatMap(([target, links]) => links.map(row => ({
      ...row, target, title: target + ' ← ' + (row.title || row.url)
    })));
    const url = URL.createObjectURL(new Blob([JSON.stringify({groups: [...groups].map(([target, links]) => ({target, links})), items}, null, 2)], {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'collected-backlinks.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();
