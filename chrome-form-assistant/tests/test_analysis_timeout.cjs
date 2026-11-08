const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const scope=vm.createContext({AbortController,setTimeout,clearTimeout,setInterval,clearInterval});
const code=fs.readFileSync(path.join(__dirname,'../extension/discovery-workflow.js'),'utf8');
vm.runInContext(code.slice(code.indexOf('function analysisBudget('),code.indexOf('async function visitBlog')),scope);
(async()=>{
 const never=()=>new Promise(()=>{});
 let budget=scope.analysisBudget(()=>false,500);
 await assert.rejects(budget.run(never,20,'读取评论'),e=>e.analysisTimeout&&e.fatal&&/读取评论超时/.test(e.message));assert(budget.signal.aborted);
 budget=scope.analysisBudget(()=>false,20);await assert.rejects(budget.run(never,500,'读取评论'),/单网站分析/);
 let stopped=false;budget=scope.analysisBudget(()=>stopped,500);const pending=budget.run(never,500,'Codex');setTimeout(()=>{stopped=true;},10);await assert.rejects(pending,/已停止/);assert(budget.signal.aborted);
 budget=scope.analysisBudget(()=>false,500);assert.equal(await budget.run(()=>Promise.resolve(42),100,'正常'),42);assert(!budget.signal.aborted);budget.close();
 // Timed-out visits must not block the next queue entry; stop preserves pending state.
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/blog-queue.js'),'utf8')+';globalThis.queue=BlogQueue;',scope);
 let jobs=[{url:'a',state:'pending'},{url:'b',state:'pending'}];
 const runner=scope.queue.create({load:async()=>jobs,save:async x=>{jobs=x;},changed:()=>{},lock:fn=>fn(),visit:async u=>{if(u==='a')return scope.analysisBudget(()=>false,30).run(never,10,'页面');return {verdict:'unknown'};}});
 await runner.run();assert.equal(jobs[0].state,'failed');assert.equal(jobs[1].state,'done');
 console.log('PASS: stalled stages, total deadline, stop cancellation, normal completion and queue continuation');
})().catch(e=>{console.error(e);process.exitCode=1;});
