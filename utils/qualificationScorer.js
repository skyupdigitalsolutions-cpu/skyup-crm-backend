// utils/qualificationScorer.js
// Pure function: given a list of {field_key, field_value} answer pairs
// and a MetaQualification doc, compute score + category.

/**
 * @param {Array<{field_key:string, field_value:string}>} fieldData   – raw Meta answers
 * @param {Object} qualDoc   – MetaQualification document (plain JS object)
 * @returns {{ leadScore:number, leadCategory:string, qualificationBreakdown:Array }}
 */
function scoreQualification(fieldData, qualDoc) {
  if (!qualDoc || !qualDoc.rules || qualDoc.rules.length === 0) {
    return { leadScore: 0, leadCategory: null, qualificationBreakdown: [] };
  }

  const { rules, thresholds } = qualDoc;
  const hot  = thresholds?.hot  ?? 70;
  const warm = thresholds?.warm ?? 40;

  // Build a quick lookup: questionKey → submitted answer
  const answerMap = {};
  (fieldData || []).forEach(({ field_key, field_value }) => {
    if (field_key) answerMap[field_key.toLowerCase()] = (field_value || "").toLowerCase();
  });

  let totalScore   = 0;
  let maxScore     = 0;
  const breakdown  = [];

  for (const rule of rules) {
    const key        = (rule.questionKey || "").toLowerCase();
    const submitted  = answerMap[key] ?? null;
    const bestAnswer = rule.answers.reduce((best, a) => (a.score > best ? a.score : best), 0);
    maxScore += bestAnswer;

    let earned = 0;
    let matchedAnswer = null;

    if (submitted !== null) {
      const match = rule.answers.find(
        (a) => (a.value || "").toLowerCase() === submitted
      );
      if (match) {
        earned        = match.score || 0;
        matchedAnswer = match.value;
      }
    }

    totalScore += earned;
    breakdown.push({
      question:      rule.questionLabel || rule.questionKey,
      answer:        matchedAnswer ?? submitted ?? "(not answered)",
      score:         earned,
      maxScore:      bestAnswer,
    });
  }

  // Percentage of maximum possible score (avoid divide-by-zero)
  const pct = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

  let leadCategory;
  if (pct >= hot)       leadCategory = "Hot";
  else if (pct >= warm) leadCategory = "Warm";
  else                  leadCategory = "Cold";

  return {
    leadScore:              totalScore,
    leadCategory,
    qualificationBreakdown: breakdown,
  };
}

module.exports = { scoreQualification };
