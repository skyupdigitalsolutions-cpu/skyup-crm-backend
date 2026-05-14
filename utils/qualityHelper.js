// utils/qualityHelper.js
// Computes Hot / Warm / Cold quality based on how completely the lead's
// fields are filled.  Call this whenever a lead is created.

/**
 * @param {object} fields  – flat object of all lead fields
 *   Must include at minimum: name, mobile
 *   Optional extras: email, plus any custom campaign question values
 * @param {number} totalCampaignQuestions
 *   How many custom questions the campaign form had (0 if not a campaign lead).
 *   Pass the count of extra fields you collected from the webhook / CSV.
 * @returns {"Hot"|"Warm"|"Cold"}
 */
function computeQuality(fields = {}, totalCampaignQuestions = 0) {
  const hasName  = !!(fields.name   && fields.name.trim()   && fields.name   !== "Unknown");
  const hasPhone = !!(fields.mobile && fields.mobile.trim() && fields.mobile !== "N/A");
  const hasEmail = !!(fields.email  && fields.email.trim());

  // Count how many of the campaign-specific custom answers are non-empty
  const filledExtras = (fields._extraAnswers || []).filter(v => v && String(v).trim()).length;

  if (!hasName || !hasPhone) return "Cold"; // bare minimum not even met

  const allCustomFilled = totalCampaignQuestions === 0 || filledExtras >= totalCampaignQuestions;

  if (hasEmail && allCustomFilled) return "Hot";  // everything filled
  if (hasEmail || filledExtras > 0) return "Warm"; // something extra filled
  return "Cold";
}

module.exports = { computeQuality };