const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../extension');
const scope = {URL, URLSearchParams};
vm.createContext(scope);
vm.runInContext(fs.readFileSync(path.join(root,'link-risk.js'),'utf8')+'\nglobalThis.risk=LinkRisk;',scope);
const risk=scope.risk;
assert.equal(risk.classify({}), 'unknown');
assert.equal(risk.classify({pageAS:90}), 'unknown');
for (const [score,expected] of [[0,'clean'],[44,'clean'],[45,'review'],[59,'review'],[60,'spam'],[100,'spam'],[-1,'unknown'],[101,'unknown'],[null,'unknown'],['0','unknown']])
  assert.equal(risk.classify({riskEvidence:{toxicity:score}}),expected);
assert.equal(risk.classify({riskEvidence:{spam:true,toxicity:0}}),'spam');
assert.equal(risk.classify({riskEvidence:{spam:false}}),'clean');
assert.equal(risk.matches({},'clean'),false);
assert.equal(risk.matches({},'exclude'),true);
assert.equal(risk.matches({riskEvidence:{spam:true}},'exclude'),false);

// Execute the actual injected parser against synthetic report cells.
vm.runInContext(fs.readFileSync(path.join(root,'semrush-capture.js'),'utf8'),scope);
function report(columns,values) {
  const cell=text=>({textContent:text,innerText:text,getClientRects:()=>[{}],matches:()=>true,querySelectorAll:()=>[]});
  const headers=columns.map(cell),headerRow={children:headers};
  headers.forEach(h=>h.closest=()=>headerRow);
  const cells=values.map(cell);
  cells[0].querySelectorAll=()=>[{href:values[0],textContent:'Source'}];
  const row={children:cells,getAttribute:()=> 'row'};
  const table={getClientRects:()=>[{}],querySelectorAll:q=>q.startsWith('th')?headers:[headerRow,row]};
  scope.document={body:table,querySelectorAll:()=>[table]};
  scope.location=new URL('https://sem.3ue.co/analytics/backlinks/backlinks/?q=target.test');
  scope.getComputedStyle=()=>({visibility:'visible'});
  return scope.readSemrushReport().rows[0];
}
assert.equal(risk.classify(report(['Source page','Page AS'],['https://source.test/post','99'])),'unknown');
assert.equal(risk.classify(report(['Source page','SPAM'],['https://source.test/post','Non-spam'])),'clean');
assert.equal(risk.classify(report(['Source page','SPAM'],['https://source.test/post','SPAM'])),'spam');
assert.equal(risk.classify(report(['源页面标题和 URL','Toxicity Score'],['https://source.test/post','65'])),'spam');
assert.equal(risk.classify(report(['Source page','Toxicity Score'],['https://source.test/post','—'])),'unknown');

// Exercise deduplication and evidence updates through the real storage function.
const panel=fs.readFileSync(path.join(root,'sidepanel.js'),'utf8');
const save=panel.slice(panel.indexOf('async function saveCollected('),panel.indexOf('async function discoveryRequest('));
let stored=[];
scope.ahrefsGroups=new Map();scope.ahrefsStorageKey='test';
scope.URLTools={canonicalURL:value=>new URL(value).href};
scope.navigator={locks:{request:async(key,fn)=>fn()}};
scope.chrome={storage:{local:{set:async value=>{stored=value.test;}}}};
scope.loadAhrefsGroups=async()=>{scope.ahrefsGroups.clear();for(const g of stored)scope.ahrefsGroups.set(g.target,g.links);};
scope.renderAhrefs=()=>{};
vm.runInContext(save,scope);
(async()=>{
  await scope.saveCollected('target.test',[{url:'https://source.test',title:'Initial'}]);
  assert.equal(risk.classify(stored[0].links[0]),'unknown');
  const result=await scope.saveCollected('target.test',[{url:'https://source.test',riskEvidence:{spam:true,source:'test',observedAt:'2026-11-07'}}]);
  assert.equal(result.added,0);assert.equal(result.total,1);
  assert.equal(risk.classify(stored[0].links[0]),'spam');
  await scope.saveCollected('target.test',[{url:'https://source.test',title:'Updated'}]);
  assert.equal(risk.classify(stored[0].links[0]),'spam');
  assert.equal(stored[0].links[0].title,'Updated');
  console.log('PASS: risk boundaries, filters, report parsing, deduplication and persistence');
})().catch(error=>{console.error(error);process.exitCode=1;});
