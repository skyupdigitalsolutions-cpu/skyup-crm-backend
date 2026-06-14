// utils/qualificationScorer.js
// Pure function: given Meta's raw field_data array and a MetaQualification doc,
// compute leadScore, maxScore, percentage + category.
//
// Scoring model:
//   • Each question's answer options sum to exactly 100 points.
//   • A lead earns the points of the single selected answer for each question.
//   • Maximum possible score = (number of questions) × 100.
//   • Percentage = (leadScore / maxScore) × 100.
//   • Category is decided by admin-configured percentage thresholds.

const POINTS_PER_QUESTION = 100;

/**
 * Accepts Meta's raw field_data array in EITHER format:
 *   • Leadgen webhook format: [{name: string, values: string[]}]
 *   • Legacy expected format: [{field_key: string, field_value: string}]
 *
 * @param {Array} fieldData   – raw Meta answers (either shape)
 * @param {Object} qualDoc    – MetaQualification document (plain JS object)
 * @returns {{
 *   leadScore:number,
 *   maxScore:number,
 *   qualificationPercentage:number,
 *   leadCategory:string,
 *   qualificationBreakdown:Array
 * }}
 */
function scoreQualification(fieldData, qualDoc) {
  if (!qualDoc || !qualDoc.rules || qualDoc.rules.length === 0) {
    return {
      leadScore:               0,
      maxScore:                0,
      qualificationPercentage: 0,
      leadCategory:            null,
      qualificationBreakdown:  [],
    };
  }

  const { rules, thresholds } = qualDoc;
  const hot  = thresholds?.hot  ?? 80;
  const warm = thresholds?.warm ?? 50;

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

  let totalScore  = 0;
  const breakdown = [];

  // Maximum possible score is fixed at 100 points per question, regardless of
  // which answer the lead picked. (Options are validated to sum to 100.)
  const maxScore = rules.length * POINTS_PER_QUESTION;

  for (const rule of rules) {
    const key       = (rule.questionKey || "").toLowerCase();
    const submitted = answerMap[key] ?? null;

    let earned        = 0;
    let matchedAnswer = null;

    if (submitted !== null) {
      const match = (rule.answers || []).find(
        (a) => (a.value || "").toLowerCase() === submitted
      );
      if (match) {
        earned        = Number(match.score) || 0;
        matchedAnswer = match.value;
      }
    }

    totalScore += earned;
    breakdown.push({
      question: rule.questionLabel || rule.questionKey,
      answer:   matchedAnswer ?? submitted ?? "(not answered)",
      score:    earned,
      maxScore: POINTS_PER_QUESTION,
    });
  }

  // Percentage of maximum possible score (avoid divide-by-zero)
  const pctRaw = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;
  // Round to 2 decimals for clean display while keeping precision.
  const qualificationPercentage = Math.round(pctRaw * 100) / 100;

  let leadCategory;
  if (qualificationPercentage >= hot)       leadCategory = "Hot";
  else if (qualificationPercentage >= warm) leadCategory = "Warm";
  else                                      leadCategory = "Cold";

  return {
    leadScore:               totalScore,
    maxScore,
    qualificationPercentage,
    leadCategory,
    qualificationBreakdown:  breakdown,
  };
}

module.exports = { scoreQualification, POINTS_PER_QUESTION };