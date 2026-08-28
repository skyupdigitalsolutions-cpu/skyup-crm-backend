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

// ─────────────────────────────────────────────────────────────────────────────
// NICHE FALLBACK LIBRARY — for leads that have no industry+service pair.
//
// Previously such leads were hard-skipped from nurture entirely (see
// jobs/nurtureSequenceJob.js) — no industry/service meant no message, ever,
// until someone tagged the lead. This is a second, smaller library that
// takes over automatically instead, so untagged leads still get something:
//
//   • Lead has a SERVICE tagged (industry missing) → the niche matched to
//     that service (e.g. service="CRM" → "crm_awareness_v1")
//   • Lead has NEITHER tagged → the "general" niche (e.g. "general_awareness_v1")
//
// NAMING: "{niche}_{stage}_v{n}" — deliberately no prefix. Niche slugs are
// single words (general, ai, crm, saanvi, website, ads, social, video,
// whatsapp) and no real industry+service slug combination ever collapses to
// just one of these words, so there's no collision risk with the real
// 1,760-template library's "{industry}_{service}_{stage}_v{n}" names.
//
// These 9 niches come from SkyUp's own AIDA outreach template set (9
// niches × 4 stages × 4 variations = 144 templates) — same stage structure
// and {{1}}/{{2}} placeholder convention as the real library, just generic
// copy instead of industry-specific copy. They must be created and approved
// in MSG91 under this exact naming before this fallback can actually send —
// this resolver only builds names, fireRule() already verifies a resolved
// name exists and is approved before spending a send, so an unsynced/
// unapproved niche template cleanly skips rather than failing.
// ─────────────────────────────────────────────────────────────────────────────

const NICHES = [
  "general", "ai", "crm", "saanvi", "website", "ads", "social", "video", "whatsapp",
];

// How many variations exist per niche/stage today (the AIDA template set has
// 4 per stage, not 5 — kept separate from the real library's variationCount
// so a rule doesn't try to build "..._v5" for a niche that only goes to v4).
const NICHE_VARIATION_COUNT = 4;

// Maps a lead's SERVICES value to the niche with matching content. SEO and
// Graphic Design have no dedicated niche in the AIDA set, so they fall back
// to "general" rather than guessing an unrelated niche.
const SERVICE_TO_NICHE = {
  "SEO":                            "general",
  "Paid Ads":                       "ads",
  "Website Design & Development":   "website",
  "AI Automation":                  "ai",
  "CRM":                            "crm",
  "Video Editing":                  "video",
  "Graphic Design":                 "general",
  "Social Media Marketing":         "social",
};

// The MSG91 template names actually in use are NOT the plain niche id — they
// come from the AIDA dashboard's NICHE_SHORT label, lowercased. E.g. niche
// "ai" → prefix "ai_automation", so the real approved template is
// "ai_automation_awareness_v1", NOT "ai_awareness_v1". Without this map the
// resolver builds names that don't exist in MSG91 and every send for those
// niches is skipped ("not found in synced MSG91 list").
const NICHE_TEMPLATE_PREFIX = {
  general: "general",
  ai:      "ai_automation",
  crm:     "crm",
  saanvi:  "saanvi_voiceagent",
  website: "website",
  ads:     "meta_googleads",
  social:  "socialmedia",
  video:   "videoediting",
  whatsapp:"whatsapp_bot",
};

/**
 * Build a niche fallback template name.
 * @param {string} niche     one of NICHES
 * @param {string} stage     awareness | interest | desire | action
 * @param {number} variation 1-based (1–4)
 */
function buildNicheTemplateName(niche, stage, variation) {
  const key = slug(niche) || "general";
  const n   = NICHE_TEMPLATE_PREFIX[key] || key;
  const st  = String(stage || "").toLowerCase().trim();
  const v   = Number(variation) || 1;
  if (!st) return "";
  return `${n}_${st}_v${v}`;
}

/**
 * Which niche to use for a lead that's missing industry+service, based on
 * whatever IS known about them. Never returns null — "general" is always a
 * valid fallback-of-last-resort.
 */
function nicheForLead(lead) {
  const service = String(lead?.service || "").trim();
  return SERVICE_TO_NICHE[service] || "general";
}

/**
 * The single entry point nurture should call instead of resolveForLead()
 * directly — always returns SOMETHING resolvable, in priority order:
 *   1. industry + service both tagged → the real 1,760-template library
 *   2. service only tagged            → the niche matched to that service
 *   3. neither tagged                 → the "general" niche
 *
 * The returned `variationCount` tells the caller which cycle length to use
 * for this lead (5 for the real library, 4 for any niche fallback) — pass
 * it into nextVariationIndex() instead of the rule's own variationCount
 * when tier !== "industry_service".
 *
 * @param {object} lead
 * @param {string} stage      awareness | interest | desire | action
 * @param {number} variation  1-based, already computed by the caller for
 *                            whichever tier this resolves to
 * @returns {{ templateName: string, tier: "industry_service"|"service_niche"|"general_niche" }}
 */
function resolveWithFallback(lead, stage, variation) {
  if (canResolve(lead)) {
    return {
      templateName: buildTemplateName(lead.industry, lead.service, stage, variation),
      tier: "industry_service",
      variationCount: 5,
    };
  }

  const service = String(lead?.service || "").trim();
  const niche = SERVICE_TO_NICHE[service] || "general";
  return {
    templateName: buildNicheTemplateName(niche, stage, variation),
    // "service_niche" only when the lead's service is a recognised SERVICES
    // value (even if that service happens to map to "general" itself, e.g.
    // SEO/Graphic Design) — "general_niche" means we know nothing at all.
    tier: SERVICE_TO_NICHE[service] ? "service_niche" : "general_niche",
    variationCount: NICHE_VARIATION_COUNT,
  };
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
  // Niche fallback library
  NICHES,
  NICHE_VARIATION_COUNT,
  SERVICE_TO_NICHE,
  NICHE_TEMPLATE_PREFIX,
  buildNicheTemplateName,
  nicheForLead,
  resolveWithFallback,
  STAGES,
  INDUSTRIES,
  SERVICES,
};
