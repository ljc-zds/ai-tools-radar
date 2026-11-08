const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const scope={};vm.createContext(scope);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/page-collection.js'),'utf8')+'\nglobalThis.collect=PageCollection;',scope);
(async()=>{
 let index=0,saved=[];
 const pages=[{rows:['a']},{rows:['b']},{rows:['a']}];
 const result=await scope.collect.run({first:pages[0],read:async()=>pages[index],advance:async()=>{index++;return{advanced:true};},signature:p=>p.rows.join(),save:async p=>saved.push(p),maxPages:5,wait:async()=>{}});
 assert.equal(saved.length,2);assert.match(result.reason,/重复/);
 index=0;saved=[];
 await scope.collect.run({first:pages[0],read:async()=>pages[++index%2],advance:async()=>({advanced:true}),signature:p=>p.rows.join(),save:async p=>saved.push(p),maxPages:1,wait:async()=>{}});
 assert.equal(index,0,'page limit never clicks or reads next page');
 saved=[];
 const timeout=await scope.collect.run({first:pages[0],read:async()=>pages[0],advance:async()=>({advanced:true}),signature:p=>p.rows.join(),save:async p=>saved.push(p),maxPages:3,wait:async()=>{}});
 assert.equal(saved.length,1);assert.match(timeout.reason,/未读到/);
 const denied=await scope.collect.run({first:pages[0],read:async()=>{},advance:async()=>({reason:'No next page'}),signature:p=>p.rows.join(),save:async()=>{},maxPages:3});
 assert.equal(denied.reason,'No next page');
 console.log('PASS: bounded pagination, duplicate-page guard, stalled-page guard and incremental saving');
})().catch(e=>{console.error(e);process.exitCode=1;});
