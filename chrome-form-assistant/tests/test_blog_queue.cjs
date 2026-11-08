const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const scope={};vm.createContext(scope);
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../extension/blog-queue.js'),'utf8')+'\nglobalThis.factory=BlogQueue;',scope);
(async()=>{
 let data=[],seen=[],queue,fail=false;
 const create=()=>scope.factory.create({load:async()=>structuredClone(data),save:async jobs=>{data=structuredClone(jobs);},lock:fn=>fn(),changed:()=>{},
 visit:async url=>{seen.push(url);if(fail){const e=Error('Bridge down');e.bridgeFailure=true;throw e;}return {verdict:'likely_guest',sites:['https://author.test/']};}});
 queue=create();await queue.enqueue([{url:'https://one.test/',remaining:2},{url:'https://one.test/',remaining:1},'https://two.test/']);
 assert.equal(data.length,2);assert.equal(data[0].remaining,2);
 await queue.run();assert.equal(seen.length,2);assert(data.every(j=>j.state==='done'));
 queue=create();await queue.run();assert.equal(seen.length,2,'completed work survives reload');
 await queue.enqueue([{url:'https://one.test/',remaining:3}]);assert.equal(data[0].remaining,3);
 await queue.enqueue(['https://three.test/','https://four.test/']);fail=true;
 const result=await queue.run();assert.equal(result.stopped,true);assert.equal(data[2].state,'failed');assert.equal(data[3].state,'pending');
 fail=false;await queue.run({retryFailed:true});assert(data.every(j=>j.state==='done'));
 data=[{url:'https://interrupted.test/',state:'running'}];await queue.run();assert.equal(data[0].state,'done');
 let active=0,peak=0,stored=[],visits=[],barrier=[];
 const parallel=scope.factory.create({load:async()=>structuredClone(stored),save:async jobs=>{await new Promise(r=>setTimeout(r,2));stored=structuredClone(jobs);},lock:fn=>fn(),changed:()=>{},visit:async url=>{active++;peak=Math.max(peak,active);visits.push(url);await new Promise(resolve=>{barrier.push(resolve);if(barrier.length===3){const batch=barrier;barrier=[];batch.forEach(done=>done());}});active--;return{verdict:'unknown'};}});
 await parallel.enqueue(Array.from({length:9},(_,i)=>'https://parallel.test/'+i));
 await parallel.run({concurrency:3});assert.equal(peak,3);assert.equal(new Set(visits).size,9);assert(stored.every(j=>j.state==='done'));
 await assert.rejects(()=>parallel.run({concurrency:6}));
 stored=[];visits=[];
 const stopping=scope.factory.create({load:async()=>structuredClone(stored),save:async jobs=>{stored=structuredClone(jobs);},lock:fn=>fn(),changed:()=>{},visit:async url=>{visits.push(url);await new Promise(r=>setTimeout(r,5));stopping.stop();return{verdict:'unknown'};}});
 await stopping.enqueue(Array.from({length:8},(_,i)=>'https://stop.test/'+i));
 await stopping.run({concurrency:3});assert.equal(visits.length,3);assert.equal(stored.filter(j=>j.state==='done').length,3);assert.equal(stored.filter(j=>j.state==='pending').length,5);
 console.log('PASS: 3 concurrent workers, serialized persistence, bounded dispatch and completed results retained on stop');
 console.log('PASS: queue deduplication, depth upgrade, persistence, recovery and bridge-failure pause');
})().catch(e=>{console.error(e);process.exitCode=1;});
