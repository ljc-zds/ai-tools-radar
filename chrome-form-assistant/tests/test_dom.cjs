// Optional development dependency: existing outreach Playwright. No extension runtime dependency.
const {chromium} = require('../../outreach/node_modules/playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const script = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
(async () => {
 const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 try {
  const page = await browser.newPage();
  await page.route('http://fixture.test/**', route => route.fulfill({body:fs.readFileSync(path.join(__dirname, 'fixtures', new URL(route.request().url()).pathname.slice(1) || 'blog.html')),contentType:'text/html'}));
  async function open(name) {
   await page.goto('http://fixture.test/' + name);
   await page.evaluate(() => {window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.listener=fn;}}}};});
   await page.evaluate(script);
  }
  const send = (kind,payload) => page.evaluate(({kind,payload}) => new Promise(resolve => window.listener({kind,payload},{id:'test'},resolve)),{kind,payload});
  await open('blog.html');
  const snapshot = (await send('analyze')).data;
  assert.equal(snapshot.groups.length,1,'CSRF should not discard comment form; unsafe forms excluded');
  assert(!snapshot.body.includes('PRIVATE'));
  assert(!JSON.stringify(snapshot).includes('PRIVATE TOKEN'));
  const group = snapshot.groups[0];
  const body = group.fields.find(f=>f.type==='textarea');
  const name = group.fields.find(f=>f.label==='Name');
  await page.evaluate(()=>{window.events=0;document.querySelector('#commentform').addEventListener('input',()=>window.events++);document.querySelector('#commentform').addEventListener('change',()=>window.events++);});
  const base={documentId:snapshot.documentId,snapshotId:snapshot.snapshotId,formId:group.id};
  let result=await send('fill',{...base,values:[{id:body.id,value:'A useful comment.'},{id:name.id,value:'Owner'}]});
  assert.equal(result.data.filled,2);
  assert.equal(await page.evaluate(()=>window.events),0,'default fill must not dispatch input/change');
  assert.equal(await page.evaluate(()=>window.submissions),0);
  await page.locator('input[name=author]').fill('My edit');
  result=await send('fill',{...base,values:[{id:body.id,value:'Overwrite attempt'}]});
  assert.equal(result.data.skipped,1);
  // Failed fill and a new analysis must preserve earlier undo records.
  assert.equal((await send('fill',{...base,values:[{id:'f999',value:'bad'}]})).ok,false);
  await send('analyze');
  result=await send('undo');
  assert.equal(result.data.restored,1);assert.equal(result.data.skipped,1);
  assert.equal(await page.locator('textarea').inputValue(),'');
  // User editing name generated two native events; default undo adds no events.
  const eventCount = await page.evaluate(()=>window.events);
  const optSnapshot=(await send('analyze')).data;
  const optBase={documentId:optSnapshot.documentId,snapshotId:optSnapshot.snapshotId,formId:optSnapshot.groups[0].id,emitEvents:true};
  await send('fill',{...optBase,values:[{id:body.id,value:'Opt in event text'}]});
  assert.equal(await page.evaluate(()=>window.events),eventCount+2);
  await send('undo');
  assert.equal(await page.evaluate(()=>window.events),eventCount+4);
  assert.equal(await page.locator('input[name=author]').inputValue(),'My edit');
  const fresh=(await send('analyze')).data;
  const freshBase={documentId:fresh.documentId,snapshotId:fresh.snapshotId,formId:fresh.groups[0].id};
  await page.evaluate(()=>history.pushState({},'', '/changed'));
  assert.equal((await send('fill',{...freshBase,values:[{id:body.id,value:'Stale'}]})).ok,false);
  await open('directory.html');
  const directory=(await send('analyze')).data;
  const fields=directory.groups[0].fields;
  const select=fields.find(f=>f.type==='select');
  const dirBase={documentId:directory.documentId,snapshotId:directory.snapshotId,formId:directory.groups[0].id};
  assert.equal((await send('fill',{...dirBase,values:[{id:select.id,value:'invalid'}]})).ok,false);
  result=await send('fill',{...dirBase,values:[{id:select.id,value:'research'}]});assert.equal(result.data.filled,1);
  await send('undo');assert.equal(await page.locator('select').inputValue(),'');
  await page.locator('textarea').evaluate(el=>el.maxLength=2);
  const desc=fields.find(f=>f.type==='textarea');
  assert.equal((await send('fill',{...dirBase,values:[{id:desc.id,value:'stale structure'}]})).ok,false);
  console.log('DOM tests passed: safe extraction, form selection, no submission, preserve edits, undo, stale page and constraints.');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
