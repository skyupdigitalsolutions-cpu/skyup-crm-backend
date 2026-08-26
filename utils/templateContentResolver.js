// utils/templateContentResolver.js
// ─────────────────────────────────────────────────────────────────────────────
// Best-effort reconstruction of the ACTUAL message text sent for a WhatsApp
// template send, so "Templates Sent" views can show what was said instead of
// just an internal template name like "crm_followup_leads".
//
// Two paths, in order of fidelity:
//   1. REAL BODY — if this template's raw MSG91 definition is cached in
//      WhatsAppTemplate (via services/msg91TemplateService.js sync), pull its
//      literal approved BODY text (with {{1}}, {{2}}… placeholders) and
//      substitute the variables that were actually sent. This is the exact
//      wording the lead received.
//   2. FALLBACK SUMMARY — if the template isn't cached yet (sync hasn't run,
//      or it's a brand-new template), build a short human-readable sentence
//      from the known variables so the record still shows THIS lead's name /
//      business / meeting details rather than nothing at all.
//
// Never throws — a resolution failure must never block a send.
// ─────────────────────────────────────────────────────────────────────────────

const WhatsAppTemplate = require("../models/WhatsAppTemplate");

// ── Pull the literal BODY component text out of a cached template's raw MSG91 payload ──
function extractBodyText(tplDoc) {
  try {
    const raw = tplDoc?.raw;
    if (!raw) return "";
    const comps = raw.components || raw.component || raw.structure?.components;
    if (!Array.isArray(comps)) return "";
    const body = comps.find(
      (c) => String(c.type || c.component_type || "").toUpperCase() === "BODY"
    );
    return body?.text || body?.value || "";
  } catch {
    return "";
  }
}

// ── Substitute {{1}}, {{2}}, … in a body string with the given values ────────
// variables: { 1: "Ramesh", 2: "Acme Interiors" }
function substitute(bodyText, variables) {
  let out = String(bodyText || "");
  for (const [key, val] of Object.entries(variables || {})) {
    out = out.split(`{{${key}}}`).join(val == null ? "" : String(val));
  }
  return out;
}

/**
 * Resolve the rendered content of a template send.
 *
 * @param {Object} opts
 * @param {string|ObjectId} opts.companyId
 * @param {string} opts.templateName
 * @param {Object} [opts.variables]   e.g. { 1: leadName, 2: businessName }
 * @param {string} [opts.fallbackText] Plain-language fallback if no cached body exists
 * @returns {Promise<string>} rendered content, or the fallback text, or ""
 */
async function resolveTemplateContent({ companyId, templateName, variables = {}, fallbackText = "" }) {
  try {
    if (!templateName) return fallbackText || "";

    const tplDoc = await WhatsAppTemplate.findOne({
      company: companyId,
      name: String(templateName).trim(),
    }).lean();

    const bodyText = extractBodyText(tplDoc);
    if (bodyText) {
      return substitute(bodyText, variables);
    }

    return fallbackText || "";
  } catch (err) {
    console.warn("[templateContentResolver] resolve error:", err.message);
    return fallbackText || "";
  }
}

module.exports = { resolveTemplateContent, extractBodyText, substitute };
