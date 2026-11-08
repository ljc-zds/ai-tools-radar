// Durable bounded concurrent queue. Commenter URLs are saved, never recursively enqueued.
const BlogQueue = {
  create({load,save,visit,changed,lock}) {
    let stopped=false;
    return {
      stop(){stopped=true;},
      async enqueue(entries,{refresh=false}={}) {
        return lock(async()=>{
          const jobs=await load(), known=new Set(jobs.map(j=>j.url));
          for(const entry of entries) {
            const {url,remaining=0}=typeof entry==='string'?{url:entry}:entry;
            if(!known.has(url)){jobs.push({url,remaining,state:'pending'});known.add(url);}
            else {const job=jobs.find(j=>j.url===url);job.remaining=Math.max(job.remaining||0,remaining);if(refresh){job.state='pending';delete job.error;}}
          }
          await save(jobs);changed(jobs);return jobs;
        });
      },
      async run({retryFailed=false,concurrency=1}={}) {
        if(!Number.isInteger(concurrency)||concurrency<1||concurrency>5)throw Error('并发数量须为 1–5。');
        stopped=false;
        return lock(async()=>{
          const jobs=await load();
          const pending=jobs.filter(job=>job.state!=='done'&&(job.state!=='failed'||retryFailed));
          let cursor=0,writes=Promise.resolve();
          const persist=()=>{
            const snapshot=JSON.parse(JSON.stringify(jobs));
            writes=writes.then(()=>save(snapshot)).catch(error=>{stopped=true;throw error;});
            return writes.then(()=>changed(jobs));
          };
          const worker=async()=>{
            while(!stopped&&cursor<pending.length){
              const job=pending[cursor++];
              job.state='running';await persist();
              if(stopped){job.state='pending';await persist();break;}
              try{
                const result=await visit(job.url,()=>stopped);
                Object.assign(job,result,{state:'done',checkedAt:new Date().toISOString()});delete job.error;
              }catch(error){
                job.state=stopped?'pending':'failed';job.error=String(error.message||error).slice(0,300);
                if(error.bridgeFailure)stopped=true;
              }
              await persist();
            }
          };
          const results=await Promise.allSettled(Array.from({length:Math.min(concurrency,pending.length)},worker));
          const failure=results.find(result=>result.status==='rejected');
          if(failure)throw failure.reason;
          return {stopped,jobs};
        });
      }
    };
  }
};
