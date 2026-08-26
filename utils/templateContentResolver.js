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
//
// MSG91 does not return one consistent shape across accounts/endpoints — it's
// been observed as: an array of {type,text} components; a keyed object
// {header,body,footer,buttons}; a flat body_text field; or nested a level
// deeper under template/data. Rather than keep guessing one shape at a time,
// this tries every known shape first, then falls back to walking the ENTIRE
// raw object and picking out the string that actually looks like the body —
// this is what finally caught templates like "crm_followup_leads" whose real
// multi-paragraph, emoji-filled body wasn't in any of the shapes we'd
// hardcoded, but was still just a plain string field somewhere in the payload.
function extractBodyText(tplDoc) {
  try {
    const raw = tplDoc?.raw;
    if (!raw) return "";
    return extractBodyTextFromRaw(raw);
  } catch {
    return "";
  }
}

function extractBodyTextFromRaw(raw) {
  if (!raw || typeof raw !== "object") return "";

  const pickFromArray = (comps) => {
    if (!Array.isArray(comps)) return "";
    const body = comps.find(
      (c) => String(c?.type || c?.component_type || "").toUpperCase() === "BODY"
    );
    const text = body?.text || body?.value || body?.body_text;
    return typeof text === "string" ? text : "";
  };

  const pickFromKeyedObject = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
    const bodyNode = obj.body || obj.BODY || obj.Body;
    if (!bodyNode) return "";
    if (typeof bodyNode === "string") return bodyNode;
    const text = bodyNode.text || bodyNode.value || bodyNode.body_text;
    return typeof text === "string" ? text : "";
  };

  // 1. Every known "components" location, as either an array or a keyed object
  const componentSources = [
    raw.components, raw.component, raw.structure?.components,
    raw.template?.components, raw.data?.components,
  ];
  for (const src of componentSources) {
    const fromArray = pickFromArray(src);
    if (fromArray) return fromArray;
    const fromKeyed = pickFromKeyedObject(src);
    if (fromKeyed) return fromKeyed;
  }

  // 2. Flat fields directly on the raw object (or one level under template/data)
  const flatSources = [raw, raw.template, raw.data];
  for (const src of flatSources) {
    if (!src || typeof src !== "object") continue;
    for (const key of ["body_text", "bodyText", "body", "template_body", "templateBody"]) {
      const v = src[key];
      if (typeof v === "string" && v.trim().length > 15) return v;
    }
  }

  // 3. Last resort — walk the whole payload, collect every string leaf, and
  // pick the one that actually looks like a message body: prefer a string
  // containing a {{n}} placeholder (the BODY is virtually always the only
  // component with one), otherwise the longest multi-word string that isn't
  // a URL, phone number, or a short label/button caption.
  const strings = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 6 || node == null) return;
    if (typeof node === "string") {
      const s = node.trim();
      if (s.length > 8 && !seen.has(s)) { seen.add(s); strings.push(s); }
      return;
    }
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (typeof node === "object") { Object.values(node).forEach((v) => walk(v, depth + 1)); }
  };
  walk(raw, 0);

  const isUrlOrPhone = (s) => /^https?:\/\//i.test(s) || /^\+?\d[\d\s-]{7,}$/.test(s);

  const withPlaceholder = strings.filter((s) => /\{\{\s*\d+\s*\}\}/.test(s) && !isUrlOrPhone(s));
  if (withPlaceholder.length) {
    return withPlaceholder.sort((a, b) => b.length - a.length)[0];
  }

  const multiWordCandidates = strings.filter((s) => !isUrlOrPhone(s) && /\s/.test(s) && s.length > 25);
  if (multiWordCandidates.length) {
    return multiWordCandidates.sort((a, b) => b.length - a.length)[0];
  }

  return "";
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

module.exports = { resolveTemplateContent, extractBodyText, extractBodyTextFromRaw, substitute };
