// utils/attribution.js
// ─────────────────────────────────────────────────────────────────────────────
// Marketing attribution capture + canonical channel classification.
//
// RULE: advertising data and CRM data are joined by PLATFORM IDs, never by
// campaign / ad names (names change, duplicate and get renamed).
//
//   Meta   : campaign_id → adset_id → ad_id
//   Google : customer_id → campaign_id → ad_group_id → ad_id / keyword
//   Web    : utm_*, gclid / gbraid / wbraid, fbclid / fbc / fbp, landing_page
//
// Everything here is best-effort and NEVER throws — a lead must always be saved
// even if attribution can't be read.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const clean = (v, max) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return "";
  return String(v).trim().slice(0, max || 500);
};

// First non-empty value from a list of candidate keys (flat body or nested
// `utm` / `tracking` / `attribution` objects that some site builders send).
function pick(body, keys) {
  if (!body || typeof body !== "object") return "";
  const bags = [body, body.utm, body.tracking, body.attribution, body.meta, body.hidden].filter(
    (b) => b && typeof b === "object"
  );
  for (const bag of bags) {
    for (const k of keys) {
      const v = clean(bag[k]);
      if (v) return v;
    }
  }
  return "";
}

// Pull utm / click-id / landing-page info out of any webhook body.
// Returns ONLY non-empty keys, ready to merge into `lead.attribution`.
function extractAttribution(body) {
  const a = {
    utmSource:   pick(body, ["utm_source", "utmSource"]),
    utmMedium:   pick(body, ["utm_medium", "utmMedium"]),
    utmCampaign: pick(body, ["utm_campaign", "utmCampaign"]),
    utmContent:  pick(body, ["utm_content", "utmContent"]),
    utmTerm:     pick(body, ["utm_term", "utmTerm"]),
    gclid:       pick(body, ["gclid", "gcl_id", "GCLID"]),
    gbraid:      pick(body, ["gbraid"]),
    wbraid:      pick(body, ["wbraid"]),
    fbclid:      pick(body, ["fbclid"]),
    fbc:         pick(body, ["fbc", "_fbc"]),
    fbp:         pick(body, ["fbp", "_fbp"]),
    landingPage: pick(body, ["landing_page", "landingPage", "page_url", "pageUrl", "page", "url", "referrer_url"]),
    formName:    pick(body, ["form_name_label", "formName", "form_title", "formTitle"]),
    // Google lead-form extension webhook ids
    googleCampaignId: pick(body, ["campaign_id", "campaignId"]),
    googleAdGroupId:  pick(body, ["adgroup_id", "ad_group_id", "adGroupId"]),
    googleAdId:       pick(body, ["creative_id", "ad_id", "adId"]),
    keyword:          pick(body, ["keyword", "utm_keyword"]),
    searchTerm:       pick(body, ["search_term", "searchTerm", "query_term"]),
  };
  const out = {};
  Object.keys(a).forEach((k) => { if (a[k]) out[k] = a[k]; });
  return out;
}

// Infer the marketing channel for a new lead from its source + click ids.
// Mirrors channelOf() in services/marketingAnalyticsService.js so stored and
// derived channels always agree.
function inferChannel(source, attr) {
  const s = String(source || "").toLowerCase();
  const a = attr || {};
  if (a.gclid || a.gbraid || a.wbraid || a.googleCampaignId) return "google";
  if (a.fbclid || a.fbc || a.metaAdId || a.metaAdsetId || a.metaCampaignId) return "meta";
  const us = String(a.utmSource || "").toLowerCase();
  if (/google|adwords|gads/.test(us)) return "google";
  if (/facebook|instagram|meta|fb|ig/.test(us)) return "meta";
  if (/linkedin/.test(us)) return "linkedin";
  if (/meta|facebook|instagram/.test(s)) return "meta";
  if (/google/.test(s)) return "google";
  if (/linkedin/.test(s)) return "linkedin";
  if (/whatsapp/.test(s)) return "whatsapp";
  if (/website|web form|webform|landing/.test(s)) return "website";
  return "organic";
}

// Build the `attribution` sub-document for a Lead.create() payload.
function buildAttribution(source, body, extra) {
  const attr = Object.assign({}, extractAttribution(body), extra || {});
  Object.keys(attr).forEach((k) => { if (!attr[k]) delete attr[k]; });
  attr.channel = inferChannel(source, attr);
  return attr;
}

// ── Meta: best-effort ad / ad set / campaign IDs for a leadgen id ────────────
// The leadgen webhook already carries ad_id + adgroup_id (= ad set id) in
// change.value — those are used first and need no extra permission. This
// follow-up GET only fills campaign_id / names and is wrapped so a missing
// permission can never block lead capture.
async function fetchMetaLeadAttribution(leadgenId, pageAccessToken, ver, changeValue) {
  const cv = changeValue || {};
  const out = {};
  if (cv.ad_id)      out.metaAdId    = clean(cv.ad_id);
  if (cv.adgroup_id) out.metaAdsetId = clean(cv.adgroup_id);
  if (!leadgenId || !pageAccessToken) return out;
  try {
    const { data } = await axios.get(
      "https://graph.facebook.com/" + (ver || "v21.0") + "/" + leadgenId,
      { params: { fields: "ad_id,ad_name,adset_id,campaign_id,form_id", access_token: pageAccessToken }, timeout: 8000 }
    );
    if (data) {
      if (data.ad_id && !out.metaAdId)        out.metaAdId = clean(data.ad_id);
      if (data.adset_id && !out.metaAdsetId)  out.metaAdsetId = clean(data.adset_id);
      if (data.campaign_id)                   out.metaCampaignId = clean(data.campaign_id);
      if (data.ad_name)                       out.metaAdName = clean(data.ad_name);
    }
  } catch (e) { /* permission / network — IDs from change.value are enough */ }
  return out;
}

module.exports = { extractAttribution, inferChannel, buildAttribution, fetchMetaLeadAttribution };
