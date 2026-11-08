// Reads a report in the user's existing browser session.
function readSemrushReport() {
  const isService = host => host === 'sem.3ue.co' || /(^|\.)semrush\.com$/i.test(host);
  if (location.origin === 'https://sem.3ue.co' && /^\/gmitm\.redirect\./i.test(location.pathname))
    return {error:'Semrush 镜像登录已失效，请在 Edge 重新登录后重试。'};
  if (location.protocol !== 'https:' || !isService(location.hostname) || !/^\/analytics\/backlinks\//i.test(location.pathname))
    return {error:'请打开 Semrush Backlinks 明细页。'};
  const params = new URLSearchParams(location.search);
  const target = params.get('q') || '';
  if (/^\/analytics\/backlinks\/pages\/?$/i.test(location.pathname)) {
    if (!target) return {error:'Indexed Pages 报告缺少查询目标。'};
    const detail = new URL('/analytics/backlinks/backlinks/',location.origin);
    for (const key of ['q','searchType']) if(params.has(key)) detail.searchParams.set(key,params.get(key));
    if(location.hostname==='sem.3ue.co' && params.has('__gmitm'))detail.searchParams.set('__gmitm',params.get('__gmitm'));
    return {detail:detail.href};
  }
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  const rows = [];
  let recognized = false;
  for (const table of [...document.querySelectorAll('table,[role="table"],[role="grid"]'),document.body]) {
    if (rows.length) break;
    if (!visible(table)) continue;
    const header = [...table.querySelectorAll('th,[role="columnheader"]')].find(el =>
      /source\s+(page|url|title)|referring\s+(page|url)|来源(?:页面|网址|标题)|源页面|引荐页面/i.test(el.textContent));
    const headerRow = header?.closest('tr,[role="row"]');
    if (!headerRow) continue;
    recognized = true;
    const index = [...headerRow.children].indexOf(header);
    const headers = [...headerRow.children];
    const spamIndex = headers.findIndex(el => /^(spam|spam status|垃圾链接|垃圾外链)$/i.test(el.textContent.trim()));
    const toxicityIndex = headers.findIndex(el => /toxicity\s*score|toxic\s*score|毒性评分|毒性分数/i.test(el.textContent));
    for (const row of table.querySelectorAll('tr,[role="row"]')) {
      const cell = row.children[index];
      if (!cell || !visible(cell) || row === headerRow ||
          (!cell.matches('td,[role="cell"],[role="gridcell"]') &&
           (row.getAttribute('role') !== 'row' || row.children.length !== headerRow.children.length))) continue;
      const raw = cell.innerText?.match(/https?:\/\/[^\s<>]+/i)?.[0];
      const anchors = [...cell.querySelectorAll('a[href]')];
      const internal = anchors.flatMap(link => {
        const href = new URL(link.href);
        return href.origin === location.origin && href.pathname === '/analytics/backlinks/overview/'
          ? [href.searchParams.get('q')] : [];
      });
      const url = [raw, ...anchors.map(link => link.href), ...internal].find(value => {
        try {
          const u = new URL(value);
          return /^https?:$/.test(u.protocol) && !isService(u.hostname);
        } catch { return false; }
      });
      if (url) {
        const spamText = row.children[spamIndex]?.textContent.trim() || '';
        const scoreText = row.children[toxicityIndex]?.textContent.trim() || '';
        const toxicity = /^\d{1,3}(?:\.\d+)?$/.test(scoreText) && Number(scoreText) <= 100 ? Number(scoreText) : null;
        const spam = /^(spam|yes|true|垃圾外链|垃圾链接|是)$/i.test(spamText) ? true :
          /^(non[- ]?spam|not spam|no|false|非垃圾|非垃圾外链|否)$/i.test(spamText) ? false : null;
        rows.push({url,title:(anchors.find(a=>a.href===url)?.textContent || '').trim().slice(0,300),
          ...(spam !== null || toxicity !== null ? {riskEvidence:{spam,toxicity,source:'Semrush 表格列',observedAt:new Date().toISOString()}} : {})});
      }
      if (rows.length >= 200) break;
    }
    if (rows.length >= 200) break;
  }
  return {rows, recognized, target};
}

