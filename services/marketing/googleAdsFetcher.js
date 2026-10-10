// services/marketing/googleAdsFetcher.js
// ─────────────────────────────────────────────────────────────────────────────
// Google Ads platform data for the Performance Marketing dashboard (live GAQL
// through the existing OAuth connection in GoogleAdsApiConfig).
//
//   campaigns · ad groups · keywords · search terms · ads (RSA) · devices ·
//   locations · landing pages · daily/hourly trend
//
// Plus GCLID resolution: for CRM leads that carry a gclid, click_view (one day
// at a time — an API restriction) returns the exact campaign / ad group /
// keyword that produced the click, so keyword-level lead QUALITY is joined by
// ID, not by name. Resolved ids are written back to the lead.
//
// Falls back to manually-entered GoogleAdsConfig cost/impressions/clicks when
// the API isn't connected (flagged `source: "manual"` — those numbers are NOT
// date-scoped, which Data Health calls out).
// No ?. / ?? operators (Beautify-safe).
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

const n  = (v) => (v == null || v === "" || isNaN(Number(v)) ? 0 : Number(v));
const r2 = (v) => Math.round(n(v) * 100) / 100;
const micros = (v) => r2(n(v) / 1000000);

function metricsOf(m) {
  m = m || {};
  const impressions = n(m.impressions), clicks = n(m.clicks), cost = micros(m.costMicros);
  return {
    spend: cost, impressions: impressions, clicks: clicks,
    ctr: impressions > 0 ? r2((clicks / impressions) * 100) : 0,
    cpc: clicks > 0 ? r2(cost / clicks) : null,
    cpm: impressions > 0 ? r2((cost / impressions) * 1000) : 0,
    platformConversions: r2(m.conversions),
  };
}

async function settle(fn) {
  try { return await fn(); }
  catch (e) {
    const msg = e && e.response && e.response.data && e.response.data.error ? e.response.data.error.message : (e && e.message ? e.message : "error");
    return { __error: msg };
  }
}
function rowsOf(res) { return res && res.results ? res.results : []; }

async function fetchLive(apiCfg, since, until) {
  const api = require("../googleAdsApiService");
  const token = await api.getValidAccessToken(apiCfg);
  const q = function (query) { return api.gaqlSearch(apiCfg, token, query); };
  const W = " WHERE segments.date BETWEEN '" + since + "' AND '" + until + "'";
  const M = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions";

  const queries = {
    campaigns: "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, " + M + " FROM campaign" + W,
    adGroups:  "SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, " + M + " FROM ad_group" + W,
    keywords:  "SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, " + M + " FROM keyword_view" + W + " ORDER BY metrics.cost_micros DESC LIMIT 1000",
    searchTerms: "SELECT campaign.id, ad_group.id, search_term_view.search_term, search_term_view.status, segments.keyword.info.text, " + M + " FROM search_term_view" + W + " ORDER BY metrics.cost_micros DESC LIMIT 1000",
    ads: "SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.status, " + M + " FROM ad_group_ad" + W + " ORDER BY metrics.cost_micros DESC LIMIT 500",
    devices: "SELECT segments.device, " + M + " FROM campaign" + W,
    locations: "SELECT segments.geo_target_city, " + M + " FROM geographic_view" + W + " ORDER BY metrics.cost_micros DESC LIMIT 100",
    landingPages: "SELECT landing_page_view.unexpanded_final_url, " + M + " FROM landing_page_view" + W + " ORDER BY metrics.cost_micros DESC LIMIT 100",
    trend: since === until
      ? "SELECT segments.hour, " + M + " FROM campaign" + W
      : "SELECT segments.date, " + M + " FROM campaign" + W,
  };

  const keys = Object.keys(queries);
  const res = await Promise.all(keys.map(function (k) { return settle(function () { return q(queries[k]); }); }));
  const R = {}; const errors = {};
  keys.forEach(function (k, i) { R[k] = res[i]; if (res[i] && res[i].__error) errors[k] = res[i].__error; });

  const campaigns = rowsOf(R.campaigns).map(function (r) {
    const c = r.campaign || {};
    return { id: String(c.id || ""), name: c.name || "", status: c.status || "", type: c.advertisingChannelType || "", metrics: metricsOf(r.metrics) };
  });
  const adGroups = rowsOf(R.adGroups).map(function (r) {
    const c = r.campaign || {}, ag = r.adGroup || {};
    return { id: String(ag.id || ""), name: ag.name || "", status: ag.status || "", campaignId: String(c.id || ""), metrics: metricsOf(r.metrics) };
  });
  const keywords = rowsOf(R.keywords).map(function (r) {
    const c = r.campaign || {}, ag = r.adGroup || {}, cr = r.adGroupCriterion || {}, kw = cr.keyword || {};
    return { id: String(cr.criterionId || ""), text: kw.text || "", matchType: kw.matchType || "", status: cr.status || "", adGroupId: String(ag.id || ""), campaignId: String(c.id || ""), metrics: metricsOf(r.metrics) };
  });
  const searchTerms = rowsOf(R.searchTerms).map(function (r) {
    const c = r.campaign || {}, ag = r.adGroup || {}, st = r.searchTermView || {}, seg = r.segments || {};
    const kwi = seg.keyword && seg.keyword.info ? seg.keyword.info : {};
    return { term: st.searchTerm || "", status: st.status || "", keyword: kwi.text || "", adGroupId: String(ag.id || ""), campaignId: String(c.id || ""), metrics: metricsOf(r.metrics) };
  });
  const ads = rowsOf(R.ads).map(function (r) {
    const c = r.campaign || {}, ag = r.adGroup || {}, aga = r.adGroupAd || {}, ad = aga.ad || {};
    const rsa = ad.responsiveSearchAd || {};
    const heads = (rsa.headlines || []).map(function (h) { return h.text; }).filter(Boolean);
    const descs = (rsa.descriptions || []).map(function (h) { return h.text; }).filter(Boolean);
    return {
      id: String(ad.id || ""), name: ad.name || (heads[0] || "Ad " + ad.id), type: ad.type || "", status: aga.status || "",
      adGroupId: String(ag.id || ""), campaignId: String(c.id || ""),
      creative: { headline: heads.slice(0, 3).join(" | "), body: descs.slice(0, 2).join(" "), linkUrl: (ad.finalUrls || [])[0] || "", headlines: heads, descriptions: descs, format: "search" },
      metrics: metricsOf(r.metrics),
    };
  });
  const devMap = {};
  rowsOf(R.devices).forEach(function (r) {
    const d = (r.segments && r.segments.device) || "UNKNOWN";
    const m = metricsOf(r.metrics);
    if (!devMap[d]) devMap[d] = { device: d, spend: 0, impressions: 0, clicks: 0, platformConversions: 0 };
    devMap[d].spend = r2(devMap[d].spend + m.spend); devMap[d].impressions += m.impressions; devMap[d].clicks += m.clicks; devMap[d].platformConversions = r2(devMap[d].platformConversions + m.platformConversions);
  });
  const devices = Object.keys(devMap).map(function (k) { const d = devMap[k]; d.ctr = d.impressions > 0 ? r2((d.clicks / d.impressions) * 100) : 0; return d; });

  // Locations → resolve geo target names in one follow-up query.
  const locRows = rowsOf(R.locations);
  const locMap = {};
  locRows.forEach(function (r) {
    const rn = (r.segments && r.segments.geoTargetCity) || "";
    if (!rn) return;
    const m = metricsOf(r.metrics);
    if (!locMap[rn]) locMap[rn] = { resource: rn, name: rn, spend: 0, impressions: 0, clicks: 0, platformConversions: 0 };
    locMap[rn].spend = r2(locMap[rn].spend + m.spend); locMap[rn].impressions += m.impressions; locMap[rn].clicks += m.clicks; locMap[rn].platformConversions = r2(locMap[rn].platformConversions + m.platformConversions);
  });
  const locKeys = Object.keys(locMap).slice(0, 100);
  if (locKeys.length) {
    const geo = await settle(function () {
      return q("SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.resource_name IN ('" + locKeys.join("','") + "')");
    });
    rowsOf(geo).forEach(function (r) {
      const g = r.geoTargetConstant || {};
      if (g.resourceName && locMap[g.resourceName]) locMap[g.resourceName].name = g.canonicalName || g.name || g.resourceName;
    });
  }
  const locations = Object.keys(locMap).map(function (k) { return locMap[k]; }).sort(function (a, b) { return b.spend - a.spend; });

  const landingPages = rowsOf(R.landingPages).map(function (r) {
    return { url: (r.landingPageView && r.landingPageView.unexpandedFinalUrl) || "", metrics: metricsOf(r.metrics) };
  });

  const trendMap = {};
  rowsOf(R.trend).forEach(function (r) {
    const seg = r.segments || {};
    const t = since === until ? since + "T" + String(seg.hour == null ? 0 : seg.hour).padStart(2, "0") : (seg.date || "");
    const m = metricsOf(r.metrics);
    if (!trendMap[t]) trendMap[t] = { t: t, spend: 0, impressions: 0, clicks: 0 };
    trendMap[t].spend = r2(trendMap[t].spend + m.spend); trendMap[t].impressions += m.impressions; trendMap[t].clicks += m.clicks;
  });
  const trend = Object.keys(trendMap).sort().map(function (k) { return trendMap[k]; });

  return { campaigns: campaigns, adGroups: adGroups, keywords: keywords, searchTerms: searchTerms, ads: ads, devices: devices, locations: locations, landingPages: landingPages, trend: trend, errors: errors, token: token };
}

// gclid → { campaignId, adGroupId, keyword } via click_view (one day per query).
async function resolveGclids(apiCfg, token, leadsWithGclid) {
  const api = require("../googleAdsApiService");
  const byDay = {};
  leadsWithGclid.forEach(function (l) {
    const d = new Date(l.createdAt);
    const days = [d.toISOString().slice(0, 10), new Date(d.getTime() - 86400000).toISOString().slice(0, 10)]; // click is usually same/prev day
    days.forEach(function (k) { if (!byDay[k]) byDay[k] = new Set(); byDay[k].add(l.gclid); });
  });
  const out = {};
  const dayKeys = Object.keys(byDay).sort().slice(-40); // bounded
  for (let i = 0; i < dayKeys.length; i++) {
    const day = dayKeys[i];
    const res = await settle(function () {
      return api.gaqlSearch(apiCfg, token,
        "SELECT click_view.gclid, click_view.keyword_info.text, click_view.keyword_info.match_type, campaign.id, ad_group.id FROM click_view WHERE segments.date = '" + day + "'");
    });
    rowsOf(res).forEach(function (r) {
      const cv = r.clickView || {};
      if (!cv.gclid || !byDay[day].has(cv.gclid)) return;
      out[cv.gclid] = {
        campaignId: String((r.campaign && r.campaign.id) || ""),
        adGroupId:  String((r.adGroup && r.adGroup.id) || ""),
        keyword:    (cv.keywordInfo && cv.keywordInfo.text) || "",
      };
    });
  }
  return out;
}

async function getGoogleAdsData({ company, since, until, refresh, gclidLeads }) {
  const key = String(company) + "|" + since + "|" + until;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const GoogleAdsApiConfig = require("../../models/GoogleAdsApiConfig");
  const GoogleAdsConfig    = require("../../models/GoogleAdsConfig");
  const manualConfigs = await GoogleAdsConfig.find({ company: company }).lean();

  const data = {
    source: "none", connected: false, fetchedAt: new Date().toISOString(),
    lastSyncedAt: null, account: null, error: null,
    campaigns: [], adGroups: [], keywords: [], searchTerms: [], ads: [], devices: [], locations: [], landingPages: [], trend: [],
    trendGranularity: since === until ? "hour" : "day",
    gclidMap: {}, errors: {},
    manualConfigs: manualConfigs,
  };

  let apiCfg = null;
  try { apiCfg = await GoogleAdsApiConfig.findOne({ company: company }); } catch (e) { apiCfg = null; }

  if (apiCfg && apiCfg.connected && apiCfg.customerId) {
    data.account = { customerId: apiCfg.customerId, customerName: apiCfg.customerName || "" };
    data.lastSyncedAt = apiCfg.lastSyncedAt || null;
    try {
      const live = await fetchLive(apiCfg, since, until);
      data.source = "api"; data.connected = true;
      ["campaigns", "adGroups", "keywords", "searchTerms", "ads", "devices", "locations", "landingPages", "trend", "errors"].forEach(function (k) { data[k] = live[k]; });
      if (Array.isArray(gclidLeads) && gclidLeads.length) {
        try { data.gclidMap = await resolveGclids(apiCfg, live.token, gclidLeads); } catch (e) { data.gclidMap = {}; }
      }
    } catch (e) {
      data.error = e && e.message ? e.message : "Google Ads API error";
      data.reauth = e && e.code === "REAUTH_REQUIRED";
    }
  }

  if (data.source !== "api" && manualConfigs.length) {
    // Manual fallback: lifetime numbers typed into the campaign config.
    data.source = "manual";
    data.campaigns = manualConfigs.map(function (c) {
      const impressions = n(c.impressions), clicks = n(c.clicks), cost = r2(c.cost);
      return {
        id: String(c.campaignId || ""), configId: String(c._id), name: c.campaignName || "", status: c.isActive === false ? "PAUSED" : "ENABLED", type: "",
        metrics: { spend: cost, impressions: impressions, clicks: clicks, ctr: impressions > 0 ? r2((clicks / impressions) * 100) : 0, cpc: clicks > 0 ? r2(cost / clicks) : null, cpm: impressions > 0 ? r2((cost / impressions) * 1000) : 0, platformConversions: 0 },
      };
    });
  }

  const totals = { spend: 0, impressions: 0, clicks: 0, platformConversions: 0 };
  data.campaigns.forEach(function (c) { totals.spend = r2(totals.spend + c.metrics.spend); totals.impressions += c.metrics.impressions; totals.clicks += c.metrics.clicks; totals.platformConversions = r2(totals.platformConversions + c.metrics.platformConversions); });
  totals.ctr = totals.impressions > 0 ? r2((totals.clicks / totals.impressions) * 100) : 0;
  totals.cpc = totals.clicks > 0 ? r2(totals.spend / totals.clicks) : null;
  data.totals = totals;

  cache.set(key, { at: Date.now(), data: data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

module.exports = { getGoogleAdsData };
