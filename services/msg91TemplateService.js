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
// NOTE: the trailing-slash forms are FIRST on purpose. A probe against a live
// account returned HTTP 308 (permanent redirect) for
// .../whatsapp/get-template/{number} on BOTH hosts, while every other path
// returned "URL not found". A 308 means the route exists but wants a different
// form — and MSG91's own send endpoint is
// .../whatsapp/whatsapp-outbound-message/bulk/ (trailing slash), so the
// redirect target is almost certainly the slashed variant.
const CANDIDATES = [
  "https://control.msg91.com/api/v5/whatsapp/get-template/{number}/",
  "https://api.msg91.com/api/v5/whatsapp/get-template/{number}/",
  "https://control.msg91.com/api/v5/whatsapp/get-template/{number}",
  "https://api.msg91.com/api/v5/whatsapp/get-template/{number}",
  "https://control.msg91.com/api/v5/whatsapp/get-templates/{number}/",
  "https://control.msg91.com/api/v5/whatsapp/template/{number}/",
  "https://control.msg91.com/api/v5/whatsapp/templates/{number}/",
  "https://control.msg91.com/api/v5/whatsapp/get-template/",
  "https://control.msg91.com/api/v5/whatsapp/get-template?integrated_number={number}",
  "https://control.msg91.com/api/v5/whatsapp/templates?integrated_number={number}",
];

function buildUrl(tpl, number) {
  return tpl.includes("{number}")
    ? tpl.replace("{number}", encodeURIComponent(number))
    : tpl;
}

/**
 * GET a URL, following up to `maxHops` redirects MANUALLY so the authkey
 * header survives every hop. Returns { status, data, finalUrl, hops }.
 *
 * axios/follow-redirects can strip custom headers when a redirect crosses
 * hosts, which would turn a working endpoint into a confusing 401. Doing it by
 * hand also lets us REPORT the redirect target, which is how we discover the
 * real path MSG91 wants.
 */
async function getFollowing(url, authKey, maxHops = 4) {
  let current = url;
  const hops = [];

  for (let i = 0; i <= maxHops; i++) {
    const res = await axios.get(current, {
      headers: { authkey: authKey, accept: "application/json" },
      timeout: 20000,
      maxRedirects: 0,             // we handle them ourselves
      validateStatus: () => true,  // never throw; inspect below
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.location;
      if (!loc) return { status: res.status, data: res.data, finalUrl: current, hops };
      // Resolve relative redirects against the current URL
      current = new URL(loc, current).toString();
      hops.push(current);
      continue;
    }
    return { status: res.status, data: res.data, finalUrl: current, hops };
  }
  return { status: 310, data: null, finalUrl: current, hops }; // too many hops
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
      const { status, data, finalUrl, hops } = await getFollowing(url, authKey);
      const via = hops.length ? ` (redirected → ${finalUrl})` : "";

      const templates = extractTemplates(data);
      if (templates && templates.length) {
        console.log(`[msg91Templates] ✅ ${templates.length} templates from ${finalUrl}`);
        return { url: finalUrl, templates };
      }

      if (status >= 200 && status < 300) {
        errors.push(`${url}${via} → HTTP ${status} but no template array. Keys: ${
          data && typeof data === "object" ? Object.keys(data).join(",") : typeof data
        }`);
      } else {
        const m = (data && (data.message || data.msg)) || `HTTP ${status}`;
        errors.push(`${url}${via} → ${String(m).slice(0, 140)}`);
      }
    } catch (e) {
      errors.push(`${url} → ${(e.message || "request failed").slice(0, 140)}`);
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
      const { status, data, finalUrl, hops } = await getFollowing(url, authKey);
      const templates = extractTemplates(data);
      results.push({
        url,
        finalUrl: finalUrl !== url ? finalUrl : undefined,
        redirectedTo: hops.length ? hops : undefined,
        httpStatus: status,
        templateCount: templates ? templates.length : 0,
        works: !!(templates && templates.length),
        // Response keys are the clue when a 200 comes back in an unexpected shape
        responseKeys: data && typeof data === "object" ? Object.keys(data).slice(0, 12) : undefined,
        sample: templates && templates[0] ? Object.keys(templates[0]).slice(0, 12) : null,
        message: templates ? undefined : String(data?.message || data?.msg || "").slice(0, 160),
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