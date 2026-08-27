// utils/templateNameResolver.js
// ─────────────────────────────────────────────────────────────────────────────
// Builds the MSG91/Meta template name for a lead from its industry + service.
//
// WHY THIS EXISTS
// There are 1,760 approved templates (11 industries × 8 services × 4 stages ×
// 5 variations). Typing those names into a rule's V1–V5 boxes would mean 352
// rules per company. Instead, a rule stores only its STAGE, and the exact
// template name is derived at send time from the lead's own industry/service.
// That makes it 4 rules per company (Awareness, Interest, Desire, Action).
//
// NAMING FORMULA (must match the template generator exactly):
//   slug(industry) + "_" + slug(service) + "_" + stage + "_v" + n
//
// Verified against live MSG91 templates:
//   Interior Designers + CRM                  + action  + 5 → interior_designers_crm_action_v5
//   Interior Designers + Social Media Marketing + desire + 2 → interior_designers_social_media_marketing_desire_v2
//   Healthcare         + SEO                  + awareness + 1 → healthcare_seo_awareness_v1
// ─────────────────────────────────────────────────────────────────────────────

// The 4 funnel stages, in order. `key` is what appears in the template name.
const STAGES = ["awareness", "interest", "desire", "action"];

// Canonical lists — these MUST match the template generator's spelling, because
// the slug of these strings becomes part of the approved template name.
const INDUSTRIES = [
  "Healthcare", "Education", "Real Estate", "Logistics", "Finance",
  "IT Solutions", "Digital Marketing", "Construction", "Local Business",
  "Interior Designers", "Professional Services",
];

const SERVICES = [
  "SEO", "Paid Ads", "Website Design & Development", "AI Automation",
  "CRM", "Video Editing", "Graphic Design", "Social Media Marketing",
];

/**
 * Lowercase, replace every run of non-alphanumeric characters with a single
 * underscore, and trim underscores from both ends.
 *   "Website Design & Development" → "website_design_development"
 *   "Interior Designers"           → "interior_designers"
 */
function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Build a template name.
 * @param {string} industry  e.g. "Interior Designers"
 * @param {string} service   e.g. "Social Media Marketing"
 * @param {string} stage     one of: awareness | interest | desire | action
 * @param {number} variation 1-based (1–5)
 * @returns {string} e.g. "interior_designers_social_media_marketing_desire_v2"
 */
function buildTemplateName(industry, service, stage, variation) {
  const i = slug(industry);
  const s = slug(service);
  const st = String(stage || "").toLowerCase().trim();
  const v = Number(variation) || 1;
  if (!i || !s || !st) return "";
  return `${i}_${s}_${st}_v${v}`;
}

/**
 * Resolve the template name for a lead at a given stage/variation.
 * Returns "" when the lead is missing industry or service — the caller must
 * treat that as "cannot send" and fall back (never guess a template, or the
 * lead receives content for the wrong vertical).
 *
 * @param {object} lead    must have .industry and .service
 * @param {string} stage   awareness | interest | desire | action
 * @param {number} variation 1-based
 */
function resolveForLead(lead, stage, variation) {
  if (!lead) return "";
  return buildTemplateName(lead.industry, lead.service, stage, variation);
}

/**
 * True when the lead has everything needed to resolve a template name.
 */
function canResolve(lead) {
  return !!(lead && slug(lead.industry) && slug(lead.service));
}

/**
 * True when a template name matches the auto-resolve library's naming
 * pattern (…_<stage>_v<n>) — i.e. it looks like it was generated for one
 * SPECIFIC industry+service combo, not a generic, works-for-everyone
 * template. Used to stop an admin from accidentally pasting one of the
 * 1,760 industry-specific names into a setting that's meant to hold ONE
 * fixed message sent to every lead regardless of vertical (Auto-Template,
 * Interested-Blast, Follow-up Reminder) — see services/autoTemplateService.js
 * staticTemplateMismatchesLeadVertical() for the runtime send-time guard
 * this pairs with.
 */
function looksLikeAutoResolvedName(name) {
  return new RegExp(`_(${STAGES.join("|")})_v\\d+$`, "i").test(String(name || "").trim());
}

module.exports = {
  slug,
  buildTemplateName,
  resolveForLead,
  canResolve,
  looksLikeAutoResolvedName,
  STAGES,
  INDUSTRIES,
  SERVICES,
};
