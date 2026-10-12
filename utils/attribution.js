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
// The leadgen webhook already carries ad_id + adgroup_id (= ad set id) in change.value — those are
// used first. A follow-up GET on the lead fills in the campaign id and names, and is the ONLY source
// for leads that arrive without webhook ids (e.g. fetched later by the backfill).
//
// Why several attempts: a Page access token usually does NOT have ads_read, and Meta rejects the
// WHOLE request when any requested field needs a permission the token lacks. So we try each token we
// have (page token, then ads token) and, per token, the full field list and then just the ids.
// Nothing here ever throws; the reason for a failure is returned so it can be shown / logged.
const LEAD_FIELD_SETS = [
  "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id",
  "ad_id,adset_id,campaign_id",
];

async function fetchMetaLeadAttributionVerbose(leadgenId, tokens, ver, changeValue) {
  const cv = changeValue || {};
  const out = {}, extra = {};
  let error = null;
  if (cv.ad_id)      out.metaAdId    = clean(cv.ad_id);
  if (cv.adgroup_id) out.metaAdsetId = clean(cv.adgroup_id);
  const haveAd = !!out.metaAdId;
  const list = (Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean);
  if (!leadgenId) return { out: out, extra: extra, error: "no Meta lead id" };
  if (!list.length) return { out: out, extra: extra, error: "no access token" };

  for (let t = 0; t < list.length; t++) {
    let answered = false;
    for (let f = 0; f < LEAD_FIELD_SETS.length && !answered; f++) {
      try {
        const res = await axios.get("https://graph.facebook.com/" + (ver || "v21.0") + "/" + leadgenId,
          { params: { fields: LEAD_FIELD_SETS[f], access_token: list[t] }, timeout: 7000 });
        const d = res.data || {};
        if (d.ad_id && !out.metaAdId)           out.metaAdId = clean(d.ad_id);
        if (d.adset_id && !out.metaAdsetId)     out.metaAdsetId = clean(d.adset_id);
        if (d.campaign_id)                      out.metaCampaignId = clean(d.campaign_id);
        if (d.ad_name)                          out.metaAdName = clean(d.ad_name);
        if (d.adset_name)                       extra.adSetName = clean(d.adset_name);
        if (d.campaign_name)                    extra.campaignName = clean(d.campaign_name);
        error = null; answered = true;
      } catch (e) {
        const fb = e && e.response && e.response.data && e.response.data.error;
        error = (fb && fb.message) || (e && e.message) || "Meta request failed";
        if (fb && fb.code === 190) break;               // token expired/invalid: a smaller field list won't help
        if (haveAd) break;                               // ids already known from the webhook — don't spend more time
      }
    }
    if (out.metaAdId) return { out: out, extra: extra, error: null };
  }
  return { out: out, extra: extra, error: out.metaAdId ? null : error };
}

// Same result shape the webhooks have always used (just the ids). Pass one token or an array.
async function fetchMetaLeadAttribution(leadgenId, tokens, ver, changeValue) {
  const r = await fetchMetaLeadAttributionVerbose(leadgenId, tokens, ver, changeValue);
  if (r.error && !r.out.metaAdId) console.warn("[metaAttribution] no ad details for lead " + leadgenId + ": " + r.error);
  return r.out;
}

module.exports = { extractAttribution, inferChannel, buildAttribution, fetchMetaLeadAttribution, fetchMetaLeadAttributionVerbose };
