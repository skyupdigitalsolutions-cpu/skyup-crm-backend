// services/msg91TemplateService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Fetches the list of approved WhatsApp templates from MSG91 and caches them
// in models/WhatsAppTemplate.js.
//
// ⚠️  ENDPOINT DISCOVERY
// MSG91's public docs render their API reference with JavaScript, so the exact
// "get templates" path could not be confirmed from the documentation. Rather
// than hardcode a guess, this service does what whatsappConfigController.js
// already does for webhook registration: it tries a list of candidate
// endpoints in order and uses the first that returns a template array.
//
// Once you know which one works (run probeTemplateEndpoints() — it prints the
// winner), set it permanently to skip the probing:
//
//   MSG91_TEMPLATES_API_URL=https://control.msg91.com/api/v5/whatsapp/<the-real-path>
//
// The URL may contain {number} which is replaced with the integrated number.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const WhatsAppTemplate = require("../models/WhatsAppTemplate");
const WhatsAppConfig   = require("../models/WhatsAppConfig");
const { STAGES }       = require("../utils/templateNameResolver");

const STAGE_SET = new Set(STAGES);

// Candidate endpoints, tried in order. {number} = integrated number.
const CANDIDATES = [
  "https://control.msg91.com/api/v5/whatsapp/get-template/{number}",
  "https://control.msg91.com/api/v5/whatsapp/get-templates/{number}",
  "https://control.msg91.com/api/v5/whatsapp/template/{number}",
  "https://control.msg91.com/api/v5/whatsapp/templates/{number}",
  "https://control.msg91.com/api/v5/whatsapp/get-template?integrated_number={number}",
  "https://control.msg91.com/api/v5/whatsapp/templates?integrated_number={number}",
  "https://api.msg91.com/api/v5/whatsapp/get-template/{number}",
  "https://api.msg91.com/api/v5/whatsapp/get-templates/{number}",
];

function buildUrl(tpl, number) {
  return tpl.includes("{number}")
    ? tpl.replace("{number}", encodeURIComponent(number))
    : tpl;
}

/**
 * MSG91 response shapes vary. Dig out an array of template objects from
 * whatever wrapper came back.
 */
function extractTemplates(data) {
  if (!data) return null;
  if (Array.isArray(data)) return data;
  for (const key of ["data", "templates", "result", "response", "template"]) {
    const v = data[key];
    if (Array.isArray(v)) return v;
    // sometimes nested one more level: { data: { templates: [...] } }
    if (v && typeof v === "object") {
      for (const k2 of ["data", "templates", "result"]) {
        if (Array.isArray(v[k2])) return v[k2];
      }
    }
  }
  return null;
}

/**
 * Count {{n}} placeholders in a template's BODY component.
 * Falls back to scanning any string field for {{n}} when the shape is unknown.
 */
function countBodyVariables(tpl) {
  const comps = tpl.components || tpl.component || tpl.structure?.components;
  if (Array.isArray(comps)) {
    const body = comps.find(
      (c) => String(c.type || c.component_type || "").toUpperCase() === "BODY"
    );
    const text = body?.text || body?.value || "";
    if (text) {
      const m = String(text).match(/\{\{\s*\d+\s*\}\}/g);
      return m ? new Set(m.map((x) => x.replace(/\D/g, ""))).size : 0;
    }
  }
  const blob = JSON.stringify(tpl || {});
  const m = blob.match(/\{\{\s*\d+\s*\}\}/g);
  return m ? new Set(m.map((x) => x.replace(/\D/g, ""))).size : 0;
}

/**
 * Parse "interior_designers_social_media_marketing_desire_v2" into its parts.
 * Returns null when the name isn't in the nurture-library format.
 *
 * Strategy: the LAST two tokens are always <stage> and v<n>; everything before
 * splits into industry + service. Because both contain underscores we can't
 * split them by position alone — but for verification purposes we only need
 * stage/variation plus the combined prefix, so industry/service are recorded
 * as the prefix and matched by full-name equality at send time.
 */
function parseNurtureName(name) {
  const parts = String(name || "").toLowerCase().split("_").filter(Boolean);
  if (parts.length < 4) return null;

  const last = parts[parts.length - 1];
  const vMatch = /^v(\d+)$/.exec(last);
  if (!vMatch) return null;

  const stage = parts[parts.length - 2];
  if (!STAGE_SET.has(stage)) return null;

  return {
    funnelStage: stage,
    variation: Number(vMatch[1]),
    prefix: parts.slice(0, parts.length - 2).join("_"), // industry_service
  };
}

/**
 * Try every candidate endpoint until one returns templates.
 * Returns { url, templates } or throws with a summary of all attempts.
 */
async function fetchFromMsg91({ authKey, integratedNumber }) {
  const configured = process.env.MSG91_TEMPLATES_API_URL;
  const list = configured ? [configured, ...CANDIDATES] : CANDIDATES;
  const errors = [];

  for (const candidate of list) {
    const url = buildUrl(candidate, integratedNumber);
    try {
      const { data } = await axios.get(url, {
        headers: { authkey: authKey, accept: "application/json" },
        timeout: 20000,
      });
      const templates = extractTemplates(data);
      if (templates && templates.length) {
        console.log(`[msg91Templates] ✅ ${templates.length} templates from ${url}`);
        return { url, templates };
      }
      errors.push(`${url} → 200 but no template array`);
    } catch (e) {
      const msg = e.response?.data?.message || e.response?.status || e.message;
      errors.push(`${url} → ${msg}`);
    }
  }
  throw new Error(
    "No MSG91 template endpoint worked. Attempts:\n  " + errors.join("\n  ") +
    "\n\nAsk MSG91 support for the correct 'get templates' URL, then set " +
    "MSG91_TEMPLATES_API_URL in Render."
  );
}

/**
 * Probe every candidate and report what each returns — run this once to find
 * the working endpoint without writing anything to the database.
 */
async function probeTemplateEndpoints(companyId) {
  const config = await WhatsAppConfig.findOne({ company: companyId }).lean();
  if (!config) throw new Error("No WhatsAppConfig for this company");

  const authKey = config.msg91AuthKey || "";
  const number  = String(config.msg91IntegratedNumber || "").replace(/\D/g, "");
  if (!authKey || !number) throw new Error("WhatsAppConfig missing msg91AuthKey or msg91IntegratedNumber");

  const results = [];
  for (const candidate of CANDIDATES) {
    const url = buildUrl(candidate, number);
    try {
      const { data, status } = await axios.get(url, {
        headers: { authkey: authKey, accept: "application/json" },
        timeout: 15000,
        validateStatus: () => true,
      });
      const templates = extractTemplates(data);
      results.push({
        url,
        httpStatus: status,
        templateCount: templates ? templates.length : 0,
        works: !!(templates && templates.length),
        sample: templates && templates[0] ? Object.keys(templates[0]).slice(0, 12) : null,
        message: templates ? undefined : (data?.message || "").toString().slice(0, 160),
      });
    } catch (e) {
      results.push({ url, works: false, message: (e.message || "").slice(0, 160) });
    }
  }
  return results;
}

/**
 * Fetch from MSG91 and upsert into the local cache.
 * @returns {{ total, nurture, other, endpoint }}
 */
async function syncTemplatesForCompany(companyId) {
  const config = await WhatsAppConfig.findOne({ company: companyId }).lean();
  if (!config) throw new Error("No WhatsAppConfig for this company");

  const authKey = config.msg91AuthKey || "";
  const number  = String(config.msg91IntegratedNumber || "").replace(/\D/g, "");
  if (!authKey) throw new Error("WhatsAppConfig.msg91AuthKey is empty");
  if (!number)  throw new Error("WhatsAppConfig.msg91IntegratedNumber is empty");

  const { url, templates } = await fetchFromMsg91({ authKey, integratedNumber: number });

  let nurture = 0;
  let other   = 0;
  const ops = [];

  for (const t of templates) {
    const name = String(
      t.template_name || t.name || t.templateName || t.elementName || ""
    ).trim();
    if (!name) continue;

    const parsed = parseNurtureName(name);
    if (parsed) nurture++; else other++;

    ops.push({
      updateOne: {
        filter: { company: companyId, name, integratedNumber: number },
        update: {
          $set: {
            company: companyId,
            name,
            integratedNumber: number,
            language: String(t.language || t.language_code || t.languageCode || "en").trim(),
            category: String(t.category || "").trim().toUpperCase(),
            status:   String(t.status || t.template_status || "").trim().toUpperCase(),
            bodyVariableCount: countBodyVariables(t),
            isNurtureTemplate: !!parsed,
            industrySlug: parsed ? parsed.prefix : "",
            serviceSlug:  "", // encoded in prefix; kept for future exact split
            funnelStage:  parsed ? parsed.funnelStage : "",
            variation:    parsed ? parsed.variation : 0,
            raw: t,
            lastSyncedAt: new Date(),
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length) await WhatsAppTemplate.bulkWrite(ops, { ordered: false });

  console.log(
    `[msg91Templates] synced ${ops.length} template(s) — ` +
    `${nurture} nurture-library, ${other} other — via ${url}`
  );
  return { total: ops.length, nurture, other, endpoint: url };
}

/**
 * Does this exact template exist (and is it approved) for this company?
 * Used by the nurture job to avoid sending a name Meta will reject.
 * Returns the cached doc, or null.
 */
async function findTemplate(companyId, name) {
  if (!name) return null;
  return WhatsAppTemplate.findOne({ company: companyId, name }).lean();
}

module.exports = {
  syncTemplatesForCompany,
  probeTemplateEndpoints,
  findTemplate,
  parseNurtureName,
  countBodyVariables,
  CANDIDATES,
};