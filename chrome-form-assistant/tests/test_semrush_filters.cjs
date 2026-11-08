const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'../extension'),scope=vm.createContext({URL,URLSearchParams});
vm.runInContext(fs.readFileSync(path.join(root,'url-utils.js'),'utf8'),scope);
const panel=fs.readFileSync(path.join(root,'sidepanel.js'),'utf8');
vm.runInContext(panel.slice(panel.indexOf('function semrushStart('),panel.indexOf("$('captureSemrush').onclick")),scope);
for(const input of ['basketball-stars.io','https://sem.3ue.co/analytics/backlinks/pages/?q=test.org&page=3&ba_rel=follow&sort_field=lasttime&__gmitm=test-session']){
 const u=new URL(scope.semrushStart(input).url);
 assert.equal(u.pathname,'/analytics/backlinks/backlinks/');assert.equal(u.searchParams.get('ba_rpp'),'blog');assert.equal(u.searchParams.get('ba_mt'),'active');assert.equal(u.searchParams.get('ba_rel'),'ugc');assert(!u.searchParams.has('page'));
 if(input.startsWith('https')){assert.equal(u.searchParams.get('__gmitm'),'test-session');assert.equal(u.searchParams.get('sort_field'),'lasttime');}
}
vm.runInContext(fs.readFileSync(path.join(root,'semrush-capture.js'),'utf8'),scope);
scope.location=new URL('https://sem.3ue.co/analytics/backlinks/pages/?q=test.org&ba_rpp=blog&ba_mt=active&ba_rel=ugc&__gmitm=test-session');
let u=new URL(scope.readSemrushReport().detail);assert.equal(u.searchParams.get('ba_rel'),'ugc');assert.equal(u.searchParams.get('__gmitm'),'test-session');
scope.location=new URL('https://sem.3ue.co/analytics/backlinks/backlinks/?q=test.org&ba_mt=lost');
u=new URL(scope.readSemrushReport().detail);assert.equal(u.searchParams.get('ba_mt'),'active');
vm.runInContext(fs.readFileSync(path.join(root,'page-collection.js'),'utf8'),scope);
scope.location=new URL(scope.semrushStart('test.org').url);
let clicks=0;
const next={tagName:'A',href:'https://sem.3ue.co/analytics/backlinks/backlinks/?q=test.org&page=2',getClientRects:()=>[{}],getAttribute:k=>k==='aria-label'?'Next page':null,closest:()=>null,click:()=>clicks++};
scope.document={querySelectorAll:()=>[next]};scope.getComputedStyle=()=>({visibility:'visible'});
assert.match(scope.advanceCollection('semrush').reason,/未保留/);assert.equal(clicks,0);
next.href+='&ba_rpp=blog&ba_mt=active&ba_rel=ugc';assert.equal(scope.advanceCollection('semrush').advanced,true);assert.equal(clicks,1);
scope.location.searchParams.delete('ba_rel');assert.match(scope.advanceCollection('semrush').reason,/变化/);
console.log('PASS: default URLs, supplied links, redirect filter preservation and next-page filter guards');
