// utils/qualificationScorer.js
// Pure function: given Meta's raw field_data array and a MetaQualification doc,
// compute score + category.

/**
 * Accepts Meta's raw field_data array in EITHER format:
 *   • Leadgen webhook format: [{name: string, values: string[]}]
 *   • Legacy expected format: [{field_key: string, field_value: string}]
 *
 * @param {Array} fieldData   – raw Meta answers (either shape)
 * @param {Object} qualDoc    – MetaQualification document (plain JS object)
 * @returns {{ leadScore:number, leadCategory:string, qualificationBreakdown:Array }}
 */
function scoreQualification(fieldData, qualDoc) {
  if (!qualDoc || !qualDoc.rules || qualDoc.rules.length === 0) {
    return { leadScore: 0, leadCategory: null, qualificationBreakdown: [] };
  }

  const { rules, thresholds } = qualDoc;
  const hot  = thresholds?.hot  ?? 70;
  const warm = thresholds?.warm ?? 40;

  // Build a quick lookup: questionKey → submitted answer.
  // Meta's leadgen webhook returns field_data as [{name, values}].
  // Normalise both shapes so scoring works regardless of which arrives.
  const answerMap = {};
  (fieldData || []).forEach((item) => {
    // Shape 1 — Meta leadgen webhook: { name: "budget", values: ["10 Lakhs"] }
    if (item.name !== undefined) {
      const key = String(item.name).toLowerCase();
      const val = Array.isArray(item.values)
        ? String(item.values[0] ?? "").toLowerCase()
        : String(item.values ?? "").toLowerCase();
      answerMap[key] = val;
    }
    // Shape 2 — legacy / test format: { field_key: "budget", field_value: "10 Lakhs" }
    if (item.field_key !== undefined) {
      const key = String(item.field_key).toLowerCase();
      answerMap[key] = String(item.field_value ?? "").toLowerCase();
    }
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