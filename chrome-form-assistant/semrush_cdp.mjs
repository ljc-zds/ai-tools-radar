// Reads the report already opened in the user's dedicated Chromium profile.
function readReport() {
  if (location.protocol !== 'https:' || !/(^|\.)semrush\.com$/i.test(location.hostname) || !/backlink/i.test(location.pathname))
    return {error:'Semrush 明细标签页已跳转，请重新打开报告。'};
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  const rows = [];
  let recognized = false;
  for (const table of document.querySelectorAll('table,[role="table"],[role="grid"]')) {
    if (!visible(table)) continue;
    const header = [...table.querySelectorAll('th,[role="columnheader"]')].find(el =>
      /source\s+(page|url|title)|referring\s+(page|url)|来源(?:页面|网址|标题)|引荐页面/i.test(el.textContent));
    const headerRow = header?.closest('tr,[role="row"]');
    if (!headerRow) continue;
    recognized = true;
    const index = [...headerRow.children].indexOf(header);
    for (const row of table.querySelectorAll('tr,[role="row"]')) {
      const cell = row.children[index];
      if (!visible(row) || !cell?.matches('td,[role="cell"],[role="gridcell"]')) continue;
      const raw = cell.innerText?.match(/https?:\/\/[^\s<>]+/i)?.[0];
      const anchors = [...cell.querySelectorAll('a[href]')].filter(visible);
      const url = [raw, ...anchors.map(link => link.href)].find(value => {
        try {
          const u = new URL(value);
          return /^https?:$/.test(u.protocol) && !/(^|\.)semrush\.com$/i.test(u.hostname);
        } catch { return false; }
      });
      if (url) rows.push({url,title:(anchors.find(a=>a.href===url)?.textContent || '').trim().slice(0,300)});
      if (rows.length >= 200) break;
    }
    if (rows.length >= 200) break;
  }
  const target = new URLSearchParams(location.search).get('q') || '';
  return {rows, recognized, target};
}

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid CDP port.');
const list = await fetch(`http://127.0.0.1:${port}/json/list`, {redirect:'error', signal:AbortSignal.timeout(3000)});
if (!list.ok) throw Error('Unable to list CDP tabs.');
const tabs = (await list.json()).filter(tab => {
  try {
    const url = new URL(tab.url);
    return tab.type === 'page' && url.protocol === 'https:' &&
      /(^|\.)semrush\.com$/i.test(url.hostname) && /backlink/i.test(url.pathname);
  } catch { return false; }
});
if (tabs.length !== 1) {
  console.log(JSON.stringify({error:'请在 CDP 浏览器中只保留一个 Semrush Backlinks 明细标签页。'}));
} else {
  const socketURL = new URL(tabs[0].webSocketDebuggerUrl);
  if (socketURL.protocol !== 'ws:' || socketURL.port !== String(port) ||
      !['127.0.0.1','localhost'].includes(socketURL.hostname) ||
      !/^\/devtools\/page\/[\w-]+$/.test(socketURL.pathname)) throw Error('Unexpected CDP socket.');
  const socket = new WebSocket(socketURL);
  try {
    const result = await new Promise((resolve,reject) => {
      const timer = setTimeout(()=>reject(Error('CDP timeout')),5000);
      const finish = (fn,value) => {clearTimeout(timer);fn(value);};
      socket.addEventListener('error',()=>finish(reject,Error('CDP connection failed')));
      socket.addEventListener('open',()=>socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
        expression:`(${readReport.toString()})()`,returnByValue:true
      }})));
      socket.addEventListener('message',({data})=>{
        const msg=JSON.parse(data);
        if(msg.id!==1)return;
        const value=msg.result?.result?.value;
        if(msg.error || msg.result?.exceptionDetails || !value) finish(reject,Error('CDP read failed'));
        else finish(resolve,value);
      });
    });
    console.log(JSON.stringify(result));
  } finally { socket.close(); }
}
