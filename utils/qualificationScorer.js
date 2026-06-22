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
//
// Improvements over v1:
//   • Answer matching is whitespace-trimmed + normalised (handles Meta trailing
//     spaces and inconsistent capitalisation in form responses).
//   • Multi-value answers (Meta checkboxes) are tried individually — the first
//     that matches a scored option wins, so checkbox questions score correctly.
//   • Partial/fuzzy fallback: if no exact match, the best-scoring answer whose
//     text is contained in the submitted value (or vice-versa) is used. This
//     handles truncated option text from the Meta API without scoring 0.
//   • Unanswered questions are tracked explicitly so the breakdown shows
//     "(not answered)" rather than silently scoring 0 with no explanation.

const POINTS_PER_QUESTION = 100;

// Normalise a raw answer string: trim whitespace, collapse internal spaces,
// lower-case. Consistent normalisation on BOTH sides prevents mismatches from
// accidental trailing spaces in Meta form responses or admin-entered options.
function norm(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Accepts Meta's raw field_data array in EITHER format:
 *   • Leadgen webhook format: [{name: string, values: string[]}]
 *   • Legacy expected format: [{field_key: string, field_value: string}]
 *
 * @param {Array}  fieldData  – raw Meta answers (either shape)
 * @param {Object} qualDoc    – MetaQualification document (plain JS object)
 * @returns {{
 *   leadScore:number,
 *   maxScore:number,
 *   qualificationPercentage:number,
 *   leadCategory:string,
 *   qualificationBreakdown:Array,
 *   unansweredCount:number
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
      unansweredCount:         0,
    };
  }

  const { rules, thresholds } = qualDoc;
  const hot  = thresholds?.hot  ?? 80;
  const warm = thresholds?.warm ?? 50;

  // Build answer lookup: normalised questionKey → array of normalised values.
  // Multi-value (checkbox) fields produce multiple entries in the array.
  const answerMap = {};   // key → string[]

  (fieldData || []).forEach((item) => {
    // Shape 1 — Meta leadgen webhook: { name: "budget", values: ["10 Lakhs"] }
    if (item.name !== undefined) {
      const key = norm(item.name);
      const vals = Array.isArray(item.values)
        ? item.values.map(norm).filter(Boolean)
        : [norm(item.values)].filter(Boolean);
      if (!answerMap[key]) answerMap[key] = [];
      answerMap[key].push(...vals);
    }
    // Shape 2 — legacy format: { field_key: "budget", field_value: "10 Lakhs" }
    if (item.field_key !== undefined) {
      const key = norm(item.field_key);
      const val = norm(item.field_value);
      if (!answerMap[key]) answerMap[key] = [];
      if (val) answerMap[key].push(val);
    }
  });

  let totalScore    = 0;
  let unansweredCount = 0;
  const breakdown   = [];

  const maxScore = rules.length * POINTS_PER_QUESTION;

  for (const rule of rules) {
    const key       = norm(rule.questionKey || "");
    const submitted = answerMap[key] ?? null;     // string[] | null

    let earned        = 0;
    let matchedAnswer = null;
    let matchMethod   = null;

    if (submitted !== null && submitted.length > 0) {
      const scoredOptions = rule.answers || [];

      // ── Pass 1: exact normalised match across all submitted values ──────────
      for (const sv of submitted) {
        const exact = scoredOptions.find((a) => norm(a.value) === sv);
        if (exact) {
          earned        = Number(exact.score) || 0;
          matchedAnswer = exact.value;
          matchMethod   = "exact";
          break;
        }
      }

      // ── Pass 2: substring containment fallback ──────────────────────────────
      // Handles truncated option text from Meta (e.g. "10 Lakh" vs "10 Lakhs")
      // or minor punctuation differences. Pick the highest-scoring option that
      // satisfies the containment check to avoid arbitrarily low matches.
      if (!matchedAnswer) {
        let bestScore  = -1;
        let bestOption = null;
        for (const a of scoredOptions) {
          const normA = norm(a.value);
          const score = Number(a.score) || 0;
          const contained = submitted.some(
            (sv) => sv.includes(normA) || normA.includes(sv)
          );
          if (contained && score > bestScore) {
            bestScore  = score;
            bestOption = a;
          }
        }
        if (bestOption) {
          earned        = bestScore;
          matchedAnswer = bestOption.value;
          matchMethod   = "fuzzy";
        }
      }
    } else {
      // Question was not answered at all
      unansweredCount++;
    }

    totalScore += earned;
    breakdown.push({
      question:    rule.questionLabel || rule.questionKey,
      answer:      matchedAnswer ?? (submitted ? submitted.join(", ") : "(not answered)"),
      score:       earned,
      maxScore:    POINTS_PER_QUESTION,
      matchMethod: matchMethod ?? (submitted ? "no_match" : "unanswered"),
    });
  }

  const pctRaw = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;
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
    unansweredCount,
  };
}

module.exports = { scoreQualification, POINTS_PER_QUESTION };
