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
