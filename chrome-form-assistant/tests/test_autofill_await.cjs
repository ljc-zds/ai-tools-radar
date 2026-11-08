const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const calls=[],scope={URL,AbortController,setTimeout,clearTimeout};let granted=true;
scope.chrome={permissions:{contains:async()=>granted,request:async()=>{throw Error('batch must use pre-granted permission');}},tabs:{create:async({url})=>{scope.url=url;return{id:1};},get:async()=>({id:1,url:scope.url,status:'complete'}),onUpdated:{addListener(){},removeListener(){}}}};
vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/autofill.js'),'utf8'),scope);
const callbacks={status:()=>{},selection:()=>({productId:'p',mode:'blog'}),ready:()=>true,canonicalURL:url=>new URL(url).href,reset:()=>{},paused:()=>{},busy:()=>{},
 analyze:async()=>calls.push('analyze'),choose:()=>({id:'f'}),selectForm:()=>{},generate:async()=>calls.push('generate'),fill:async()=>{calls.push('fill');return{filled:1};},submit:async()=>{await new Promise(r=>setTimeout(r,20));calls.push('submit');}};
(async()=>{
 const automation=scope.AutoFill.create(callbacks);
 await automation.openAuthorized('https://blog.test/post');
 assert.deepEqual(calls,['analyze','generate','fill','submit'],'await must include submit completion');
 granted=false;await assert.rejects(()=>automation.openAuthorized('https://blog.test/other'));
 assert.equal(calls.length,4,'no work without permission');
 console.log('PASS: authorized batch awaits full autofill and submission, denies missing permission');
})().catch(e=>{console.error(e);process.exitCode=1;});
