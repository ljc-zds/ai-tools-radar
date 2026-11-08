// Missing evidence is unknown, never a clean verdict. Page AS is not a spam score.
const LinkRisk = {
  classify(item) {
    const evidence = item.riskEvidence;
    if (!evidence) return 'unknown';
    if (evidence.spam === true) return 'spam';
    const score = evidence.toxicity;
    if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100) {
      if (score >= 60) return 'spam';
      if (score >= 45) return 'review';
      return 'clean';
    }
    return evidence.spam === false ? 'clean' : 'unknown';
  },
  matches(item, filter) {
    const risk = this.classify(item);
    return filter === 'all' || (filter === 'exclude' ? risk !== 'spam' : risk === filter);
  },
  labels: {clean:'非 SPAM（已有证据）', spam:'SPAM / 高风险', review:'待复核', unknown:'未知（无风险数据）'},
};

// Independent page assessment; never a vendor toxicity score.
const PageQuality = {
  labels: {low:'较低风险（样本内）',review:'待复核',high:'高风险',unknown:'证据不足'},
  assess(evidence,model) {
    const sample=evidence.qualitySample;
    const base={version:1,source:'local_page_codex',checkedAt:new Date().toISOString(),level:'unknown',signals:[],
      coverage:sample?{comments:sample.comments.length,articleCharacters:sample.article.length}:null,
      reason:'未完成页面质量分析；不能据此判断安全。',relevance:'unknown'};
    if(!sample||!model)return base;
    const texts=[sample.title,sample.article,...sample.comments.map(c=>c.text)];
    const allowed=['unrelated_promotion','repeated_comments','link_stuffing','thin_content'];
    const signals=(Array.isArray(model.signals)?model.signals:[]).filter(s=>s&&allowed.includes(s.type)&&typeof s.quote==='string'&&s.quote.trim().length>=8&&texts.some(t=>t.includes(s.quote.trim())))
      .slice(0,8).map(s=>({type:s.type,quote:s.quote.trim().slice(0,300)}));
    let level=['low','review','high'].includes(model.level)?model.level:'unknown';
    if(level==='high'&&new Set(signals.map(s=>s.type)).size<2)level=signals.length?'review':'unknown';
    if(level==='review'&&!signals.length)level='unknown';
    if(level==='low'&&(signals.length||sample.article.length<300||sample.comments.length<3))level=signals.length?'review':'unknown';
    return {...base,level,signals,reason:level==='unknown'?'证据或样本不足，暂不判断安全。':String(model.reason||'').slice(0,400)};
  },
  level(job){return job?.state==='done'&&job.quality?.version===1?job.quality.level:'unknown';},
  matches(job,filter){const level=this.level(job);return filter==='all'||(filter==='exclude'?level!=='high':filter===level);},
};

// Topics describe the source article, never eligibility or promotion-target relevance.
const ResourceTopics = {
  labels:['新闻','美食','科技','教育','游戏','体育','旅游','健康','金融','商业','生活','艺术文化','法律','科学','综合','其他'],
  normalize(value){return [...new Set((Array.isArray(value)?value:[]).filter(tag=>this.labels.includes(tag)))].slice(0,3);},
  get(job){return this.normalize(job?.topics);},
  matches(job,filter){const tags=this.get(job);return filter==='all'||(filter==='unknown'?!tags.length:tags.includes(filter));},
};
