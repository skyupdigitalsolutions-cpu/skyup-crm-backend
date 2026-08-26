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
const { encrypt, hmac } = require("../utils/fieldCrypto");
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
// Request shapes to try against each candidate. HTTP 400 from
// get-template/{number}/ proved the ROUTE exists but rejected our request, so
// the variable is no longer the path — it is the method and the payload.
const ATTEMPTS = [
  { method: "get",  body: null },
  { method: "post", body: {} },
  { method: "post", body: { integrated_number: "{number}" } },
  { method: "post", body: { integrated_number: "{number}", template_status: "APPROVED" } },
];

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
async function getFollowing(url, authKey, maxHops = 4, method = "get", body = null) {
  let current = url;
  const hops = [];

  for (let i = 0; i <= maxHops; i++) {
    const res = await axios.request({
      url: current,
      method,
      data: body || undefined,
      headers: {
        authkey: authKey,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
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

  // Try every key at every level of nesting — MSG91 response shapes vary
  // between accounts. Known shapes observed:
  //  { data: [...] }
  //  { data: { templates: [...] } }
  //  { templates: [...] }
  //  { response: [...] }
  //  { result: { data: [...] } }
  //  { status:"success", data:[...] }
  const tryKeys = ["data","templates","result","response","template",
                   "list","items","records","payload","content","body"];
  for (const key of tryKeys) {
    const v = data[key];
    if (Array.isArray(v) && v.length > 0) return v;
    if (v && typeof v === "object") {
      for (const k2 of tryKeys) {
        if (Array.isArray(v[k2]) && v[k2].length > 0) return v[k2];
        if (v[k2] && typeof v[k2] === "object") {
          for (const k3 of tryKeys) {
            if (Array.isArray(v[k2][k3]) && v[k2][k3].length > 0) return v[k2][k3];
          }
        }
      }
    }
  }

  // Last resort: find any top-level key whose value is a non-empty array
  // (catches unusual wrappers like { TEMPLATES: [...] })
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key]) && data[key].length > 0) return data[key];
  }

  return null;
}

/**
 * Normalize MSG91 status strings to a consistent set.
 * MSG91 dashboard shows "Enabled" / "Pending" / "Rejected" / "Disabled".
 * Some API responses may use different casing or alternate spellings.
 * We store a canonical value so the frontend and job can do simple equality checks.
 *   "APPROVED" = live and sendable
 *   "PENDING"  = awaiting Meta review
 *   "REJECTED" = refused by Meta
 *   "PAUSED"   = temporarily disabled
 *   ""         = unknown / not returned
 */
function normalizeStatus(raw) {
  const v = String(raw || "").trim().toUpperCase();
  if (["ENABLED", "APPROVED", "ACTIVE", "LIVE"].includes(v)) return "APPROVED";
  if (["PENDING", "IN_APPEAL", "PENDING_DELETION", "PENDING_REVIEW", "SUBMITTED"].includes(v)) return "PENDING";
  if (["REJECTED", "REJECTED_BY_META", "REFUSED", "FLAGGED", "DISABLED_BY_META"].includes(v)) return "REJECTED";
  if (["PAUSED", "DISABLED", "INACTIVE", "ARCHIVED"].includes(v)) return "PAUSED";
  return v; // keep as-is for anything unknown
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

    for (const attempt of ATTEMPTS) {
      const body = attempt.body
        ? JSON.parse(JSON.stringify(attempt.body).replace(/\{number\}/g, integratedNumber))
        : null;
      const label = `${attempt.method.toUpperCase()} ${url}${body ? ` body=${JSON.stringify(body)}` : ""}`;

      try {
        const { status, data, finalUrl, hops } = await getFollowing(
          url, authKey, 4, attempt.method, body
        );
        const via = hops.length ? ` (→ ${finalUrl})` : "";

        const templates = extractTemplates(data);
        if (templates && templates.length) {
          console.log(`[msg91Templates] ✅ ${templates.length} templates via ${label}`);
          return { url: finalUrl, templates, method: attempt.method, body };
        }

        // 404 = wrong path, not worth trying other shapes on this candidate.
        const notFound = /not found on the server/i.test(
          String(data?.message || data?.msg || "")
        );
        if (notFound) {
          errors.push(`${label}${via} → route does not exist`);
          break; // skip remaining ATTEMPTS for this URL
        }

        // Anything else: dump the WHOLE body. When MSG91 answers 400 it is
        // telling us exactly which parameter it wants — that message is the
        // single most useful thing for finding the right call.
        const dump = (() => {
          try { return JSON.stringify(data).slice(0, 400); }
          catch { return String(data).slice(0, 400); }
        })();
        errors.push(`${label}${via} → HTTP ${status} ${dump}`);
      } catch (e) {
        errors.push(`${label} → ${(e.message || "request failed").slice(0, 140)}`);
      }
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
  const rawNum  = String(config.msg91IntegratedNumber || "").replace(/\D/g, "");
  if (!authKey || !rawNum) throw new Error("WhatsAppConfig missing msg91AuthKey or msg91IntegratedNumber");
  const number  = rawNum.length === 10 ? `91${rawNum}` : rawNum;

  const results = [];
  for (const candidate of CANDIDATES) {
    const url = buildUrl(candidate, number);
    for (const attempt of ATTEMPTS) {
    const body = attempt.body
      ? JSON.parse(JSON.stringify(attempt.body).replace(/\{number\}/g, number))
      : null;
    try {
      const { status, data, finalUrl, hops } = await getFollowing(url, authKey, 4, attempt.method, body);
      const templates = extractTemplates(data);
      results.push({
        method: attempt.method.toUpperCase(),
        requestBody: body || undefined,
        // FULL response body — this is where MSG91 explains a 400
        responseBody: (() => { try { return JSON.stringify(data).slice(0, 500); } catch { return String(data).slice(0, 500); } })(),
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
      results.push({ url, method: attempt.method.toUpperCase(), works: false, message: (e.message || "").slice(0, 160) });
    }
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
  const rawNum  = String(config.msg91IntegratedNumber || "").replace(/\D/g, "");
  if (!authKey) throw new Error("WhatsAppConfig.msg91AuthKey is empty");
  if (!rawNum)  throw new Error("WhatsAppConfig.msg91IntegratedNumber is empty");

  // MSG91 requires the INTERNATIONAL format (country code prefix).
  // The DB may store "9591327778" (10-digit) or "919591327778" (12-digit).
  // Normalise to 12-digit for India: prefix 91 if exactly 10 digits.
  const number = rawNum.length === 10 ? `91${rawNum}` : rawNum;

  const { url, templates } = await fetchFromMsg91({ authKey, integratedNumber: number });

  // PERF/SECURITY NOTE: Model.bulkWrite() below bypasses ALL Mongoose schema
  // middleware — the encryptedFieldsPlugin's encrypt hook and the
  // integratedNumberHash-computing hook on WhatsAppTemplate never fire for it.
  // So this service is responsible for computing the hash and encrypting the
  // value itself. `number` is the same WhatsApp sender number for every
  // template in this sync call, so the hash is computed once here.
  const numberHash = hmac(number);

  let nurture = 0;
  let other   = 0;
  const ops = [];

  // Capture the ACTUAL field names MSG91 returned, so we can see whether a
  // status field exists under a name we have not checked yet. Surfaced in the
  // sync response and logged — this is how we stop guessing.
  const sampleKeys = templates[0] ? Object.keys(templates[0]) : [];
  const sampleRow  = templates[0] ? JSON.stringify(templates[0]).slice(0, 600) : "";
  console.log("[msg91Templates] fields returned by MSG91:", sampleKeys.join(", "));
  console.log("[msg91Templates] first template raw:", sampleRow);

  for (const t of templates) {
    const name = String(
      t.template_name || t.name || t.templateName || t.elementName || ""
    ).trim();
    if (!name) continue;

    const parsed = parseNurtureName(name);
    if (parsed) nurture++; else other++;

    ops.push({
      updateOne: {
        filter: { company: companyId, name, integratedNumberHash: numberHash },
        update: {
          $set: {
            company: companyId,
            name,
            integratedNumber: encrypt(number),
            integratedNumberHash: numberHash,
            language: String(t.language || t.language_code || t.languageCode || "en").trim(),
            category: String(t.category || "").trim().toUpperCase(),
            // MSG91 field naming varies by account/endpoint. Check every
            // plausible field before giving up. If the API returns NO status
            // field at all, we treat the template as APPROVED — MSG91's
            // get-template endpoint only returns live/enabled templates, and
            // the dashboard confirms they show as "Enabled".
            status: normalizeStatus(
              // Top-level status fields (some MSG91 endpoints)
              t.status ?? t.template_status ?? t.status_name ?? t.approval_status ??
              t.state ?? t.template_state ?? t.templateStatus ?? t.approvalStatus ??
              // MSG91 get-template endpoint returns status INSIDE languages[].status
              // e.g. languages: [{ status: "approved", ... }]
              (Array.isArray(t.languages) && t.languages.length > 0
                ? (t.languages[0].status ?? t.languages[0].template_status ?? t.languages[0].approval_status)
                : undefined) ??
              // boolean/numeric forms some APIs use
              (t.is_active === true || t.active === true || t.enabled === true ? "ENABLED" : undefined) ??
              (t.is_active === false || t.active === false || t.enabled === false ? "DISABLED" : undefined) ??
              // Nothing returned → we genuinely do not know.
              "UNKNOWN"
            ),
            // Keep whatever the API actually sent so the UI can show the truth
            rawStatusField: (() => {
              for (const k of ["status","template_status","status_name","approval_status","state","template_state","templateStatus","approvalStatus","is_active","active","enabled"]) {
                if (t[k] !== undefined) return `${k}=${String(t[k])}`;
              }
              // Also check inside languages[0]
              if (Array.isArray(t.languages) && t.languages.length > 0) {
                const lang = t.languages[0];
                for (const k of ["status","template_status","approval_status"]) {
                  if (lang[k] !== undefined) return `languages[0].${k}=${String(lang[k])}`;
                }
              }
              return "(no status field in MSG91 response)";
            })(),
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
  return { total: ops.length, nurture, other, endpoint: url, sampleKeys, sampleRow };
}

/**
 * Fetch the raw MSG91 response for the working endpoint — returns it as-is so
 * you can see exactly what shape MSG91 sends and tune extractTemplates if needed.
 */
async function fetchRaw(companyId) {
  const config = await WhatsAppConfig.findOne({ company: companyId }).lean();
  if (!config) throw new Error("No WhatsAppConfig for this company");

  const authKey = config.msg91AuthKey || "";
  const rawNum  = String(config.msg91IntegratedNumber || "").replace(/\D/g, "");
  if (!authKey) throw new Error("msg91AuthKey empty");
  if (!rawNum)  throw new Error("msg91IntegratedNumber empty");
  const number  = rawNum.length === 10 ? `91${rawNum}` : rawNum;

  // Only try the two candidates that returned non-404 previously
  const urls = [
    `https://control.msg91.com/api/v5/whatsapp/get-template/${number}/`,
    `https://api.msg91.com/api/v5/whatsapp/get-template/${number}/`,
  ];
  const results = [];
  for (const url of urls) {
    for (const attempt of ATTEMPTS) {
      const body = attempt.body
        ? JSON.parse(JSON.stringify(attempt.body).replace(/\{number\}/g, number))
        : null;
      try {
        const { status, data, finalUrl } = await getFollowing(url, authKey, 4, attempt.method, body);
        results.push({
          url, finalUrl, method: attempt.method.toUpperCase(),
          requestBody: body, httpStatus: status,
          // FULL raw response — this is what we need to see to tune the parser
          rawResponse: data,
          templateCount: extractTemplates(data)?.length ?? "null (not found by parser)",
        });
        if (extractTemplates(data)?.length > 0) return results; // found them, stop early
      } catch (e) {
        results.push({ url, method: attempt.method.toUpperCase(), error: e.message });
      }
    }
  }
  return results;
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

/**
 * Fetch ONE template's real approved body text LIVE from MSG91 — not the
 * local cache. Used for the "View" content modal so a lead's actual sent
 * template always shows the true wording, even for a template that hasn't
 * been synced (or was renamed/edited) since the last sync run.
 *
 * MSG91 has no "get one template" endpoint, so this pulls the full list
 * (same call the sync job makes) and picks out the matching one. While
 * we're at it, we also upsert that single template into the local cache so
 * the next lookup for the same name is instant and doesn't need to hit
 * MSG91 again.
 *
 * @returns {{ body: string, template: object|null, source: "msg91-live" }}
 */
async function fetchLiveTemplateBody(companyId, name) {
  const target = String(name || "").trim();
  if (!target) return { body: "", template: null, source: "msg91-live" };

  const config = await WhatsAppConfig.findOne({ company: companyId }).lean();
  if (!config) throw new Error("No WhatsAppConfig for this company");

  const authKey = config.msg91AuthKey || "";
  const rawNum  = String(config.msg91IntegratedNumber || "").replace(/\D/g, "");
  if (!authKey) throw new Error("WhatsAppConfig.msg91AuthKey is empty");
  if (!rawNum)  throw new Error("WhatsAppConfig.msg91IntegratedNumber is empty");
  const number = rawNum.length === 10 ? `91${rawNum}` : rawNum;

  const { templates } = await fetchFromMsg91({ authKey, integratedNumber: number });

  const match = (templates || []).find((t) => {
    const n = String(t.template_name || t.name || t.templateName || t.elementName || "").trim();
    return n.toLowerCase() === target.toLowerCase();
  });

  if (!match) {
    return { body: "", template: null, source: "msg91-live" };
  }

  const comps = match.components || match.component || match.structure?.components;
  let body = "";
  if (Array.isArray(comps)) {
    const bodyComp = comps.find(
      (c) => String(c.type || c.component_type || "").toUpperCase() === "BODY"
    );
    body = bodyComp?.text || bodyComp?.value || "";
  }

  // Best-effort: refresh the cache for this one template so future views
  // (and future sends) don't need to hit MSG91 again. Never let a cache
  // write failure block returning the live result to the caller.
  try {
    const numberHash = hmac(number);
    await WhatsAppTemplate.updateOne(
      { company: companyId, name: target, integratedNumberHash: numberHash },
      {
        $set: {
          company: companyId,
          name: target,
          integratedNumber: encrypt(number),
          integratedNumberHash: numberHash,
          language: String(match.language || match.language_code || match.languageCode || "en").trim(),
          category: String(match.category || "").trim().toUpperCase(),
          bodyVariableCount: countBodyVariables(match),
          raw: match,
          lastSyncedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn("[msg91Templates] fetchLiveTemplateBody cache refresh failed:", e.message);
  }

  return { body, template: match, source: "msg91-live" };
}

module.exports = {
  syncTemplatesForCompany,
  probeTemplateEndpoints,
  fetchRaw,
  findTemplate,
  fetchLiveTemplateBody,
  parseNurtureName,
  countBodyVariables,
  CANDIDATES,
};
