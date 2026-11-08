// Serialized by scripting.executeScript; keep the page reader self-contained.
function readAhrefsResults() {
  if (location.origin !== 'https://ahrefs.com' || !/^\/backlink-checker\/?$/.test(location.pathname))
    return {error: '请在 Ahrefs 免费反链检查器结果页打开侧栏。'};
  const shown = element => element.getClientRects().length > 0 &&
    !element.closest('[hidden],[aria-hidden="true"]') &&
    getComputedStyle(element).visibility === 'visible';
  const rows = [];
  const tables = [...document.querySelectorAll('table,[role="table"],[role="grid"]')].filter(shown);
  for (const [index, table] of tables.entries()) {
    if (!shown(table)) continue;
    const headers = [...table.querySelectorAll('th,[role="columnheader"]')];
    const source = headers.find(header =>
      /referring\s+(?:page|url)|source\s+(?:page|url)|引荐页面|引用页面|来源页面|来源网址|反向链接页面/i.test(header.textContent));
    if (!source) continue;
    const headerRow = source.closest('tr,[role="row"]');
    const column = headerRow ? [...headerRow.children].indexOf(source) : -1;
    if (column < 0) continue;
    // The promo and scroll wrappers can put the continuation several levels away.
    const parts = [table];
    const cellCount = headerRow.children.length;
    const scope = table.closest('dialog,[role="dialog"],[aria-modal="true"]');
    for (const next of tables.slice(index + 1)) {
      if (column !== 1 || cellCount !== 3) break;
      if (scope ? !scope.contains(next) : next.closest('dialog,[role="dialog"],[aria-modal="true"]')) break;
      const nextHeaders = [...next.querySelectorAll('th,[role="columnheader"]')];
      if (nextHeaders.some(header => shown(header) && header.innerText?.trim())) break;
      const dataRows = [...next.querySelectorAll('tr,[role="row"]')].filter(row =>
        shown(row) && row.children.length === cellCount && row.children[column]?.matches('td,[role="cell"],[role="gridcell"]'));
      if (!dataRows.length || !dataRows.every(row =>
        /^\d+(?:[.,]\d+)?$/.test(row.children[0].textContent.trim()) &&
        row.children[column].querySelector('a[href]'))) break;
      parts.push(next);
    }
    for (const [part, body] of parts.entries()) {
    for (const row of body.querySelectorAll('tr,[role="row"]')) {
      if (!shown(row)) continue;
      if (part && (row.children.length !== 3 || !/^\d+(?:[.,]\d+)?$/.test(row.children[0].textContent.trim()))) continue;
      const cell = row.children[column];
      if (!cell || !cell.matches('td,[role="cell"],[role="gridcell"]')) continue;
      for (const link of cell.querySelectorAll('a[href]')) {
        if (!shown(link)) continue;
        const url = new URL(link.href);
        if (!['https:', 'http:'].includes(url.protocol) ||
            /(^|\.)ahrefs\.com$/i.test(url.hostname)) continue;
        rows.push({url: url.href, title: link.textContent.trim().slice(0, 300)});
        break;
      }
    }
    }
  }
  // The results title can be a styled div/span, with the URL in a separate node.
  let target = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; !target && (node = walker.nextNode());) {
    if (!/backlink profile for|反链概况|反向链接/i.test(node.nodeValue)) continue;
    let element = node.parentElement;
    for (let depth = 0; element && depth < 3; depth++, element = element.parentElement) {
      if (!shown(element)) break;
      const text = element.innerText?.trim() || '';
      if (text.length > 450) break;
      target = text.match(/^(?:backlink profile for|反链概况|反向链接(?:概况)?)\s*[:：]?\s*(https?:\/\/[^\s]+)/i)?.[1] || '';
      if (target) break;
    }
  }
  return {rows: rows.slice(0, 200), target: target ||
    new URLSearchParams(location.search).get('target') || ''};
}
