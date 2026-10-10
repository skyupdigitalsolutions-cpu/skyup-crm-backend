// services/marketing/metaAdsFetcher.js
// ─────────────────────────────────────────────────────────────────────────────
// Pulls Meta Ads platform data for the Performance Marketing dashboard, keyed
// by PLATFORM IDS (campaign_id → adset_id → ad_id). One pass per unique ad
// account (never per MetaConfig — that double-counted spend before).
//
// Per account:
//   1. insights level=campaign / adset / ad   (spend, reach, freq, link clicks,
//      LPV, platform leads …)
//   2. /campaigns + id-batch statuses          (one canonical effective_status)
//   3. creatives for every ad that delivered   (id-batch, 50 per call)
//   4. ad insights for 1st half vs 2nd half    (creative-fatigue detection)
//   5. account trend: daily, or hourly for a single-day range
//
// Results are cached in-process for CACHE_TTL_MS per company+range so the
// Overview, Paid Media, Creatives and Reports tabs share one fetch. Pass
// refresh=true to bypass ("Sync now").
// No ?. / ?? operators (Beautify-safe, matches the rest of /services).
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");

const DEFAULT_VER  = process.env.META_GRAPH_API_VERSION || "v21.0";
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { at, data }

const n  = (v) => (v == null || v === "" || isNaN(Number(v)) ? 0 : Number(v));
const r2 = (v) => Math.round(n(v) * 100) / 100;

function actId(acct) {
  const a = String(acct || "").trim();
  if (!a) return "";
  return a.indexOf("act_") === 0 ? a : "act_" + a.replace(/[^0-9]/g, "");
}

function fbError(e) {
  const err = e && e.response && e.response.data && e.response.data.error ? e.response.data.error : null;
  return {
    message: err && err.message ? err.message : (e && e.message ? e.message : "Unknown Meta API error"),
    code: err && err.code ? err.code : null,
  };
}

// GET with paging.next follow-through (guarded).
async function getAll(url, params, maxPages) {
  const rows = [];
  let next = url;
  let p = params;
  let guard = 0;
  while (next && guard < (maxPages || 20)) {
    const res = await axios.get(next, { params: p, timeout: 30000 });
    const body = res.data || {};
    const data = Array.isArray(body.data) ? body.data : [];
    for (let i = 0; i < data.length; i++) rows.push(data[i]);
    next = body.paging && body.paging.next ? body.paging.next : null;
    p = undefined;
    guard++;
  }
  return rows;
}

// Batch object lookup by ids (Graph allows max 50 ids per request).
async function getByIds(ver, ids, fields, token) {
  const out = {};
  const uniq = Array.from(new Set(ids.filter(Boolean).map(String)));
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    try {
      const res = await axios.get("https://graph.facebook.com/" + ver + "/", {
        params: { ids: chunk.join(","), fields: fields, access_token: token },
        timeout: 25000,
      });
      const body = res.data || {};
      Object.keys(body).forEach(function (k) { out[k] = body[k]; });
    } catch (e) { /* best-effort per chunk */ }
  }
  return out;
}

function actionValue(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (let t = 0; t < types.length; t++) {
    for (let i = 0; i < actions.length; i++) {
      if (actions[i] && actions[i].action_type === types[t]) return n(actions[i].value);
    }
  }
  return 0;
}
const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "leadgen_grouped", "offsite_conversion.fb_pixel_lead"];
const LPV_TYPES  = ["landing_page_view", "omni_landing_page_view"];

const INSIGHT_FIELDS = "spend,impressions,reach,frequency,clicks,inline_link_clicks,inline_link_click_ctr,ctr,cpm,actions";

function rowMetrics(row) {
  const spend = n(row.spend), impressions = n(row.impressions), clicks = n(row.clicks);
  const linkClicks = n(row.inline_link_clicks);
  return {
    spend: r2(spend),
    impressions: impressions,
    reach: n(row.reach),
    frequency: r2(row.frequency),
    clicks: clicks,
    linkClicks: linkClicks,
    ctr: r2(row.ctr),
    linkCtr: impressions > 0 ? r2((linkClicks / impressions) * 100) : 0,
    cpm: r2(row.cpm),
    cpc: linkClicks > 0 ? r2(spend / linkClicks) : null,          // cost per LINK click
    lpv: actionValue(row.actions, LPV_TYPES),
    platformLeads: actionValue(row.actions, LEAD_TYPES),
  };
}

function emptyMetrics() {
  return { spend: 0, impressions: 0, reach: 0, frequency: 0, clicks: 0, linkClicks: 0, ctr: 0, linkCtr: 0, cpm: 0, cpc: null, lpv: 0, platformLeads: 0 };
}

function addMetrics(a, b) {
  a.spend = r2(a.spend + b.spend);
  a.impressions += b.impressions;
  a.reach += b.reach;            // NOTE: reach is not additive across objects; summed only as an upper bound
  a.clicks += b.clicks;
  a.linkClicks += b.linkClicks;
  a.lpv += b.lpv;
  a.platformLeads += b.platformLeads;
  return a;
}
function finalizeMetrics(m) {
  m.ctr = m.impressions > 0 ? r2((m.clicks / m.impressions) * 100) : 0;
  m.linkCtr = m.impressions > 0 ? r2((m.linkClicks / m.impressions) * 100) : 0;
  m.cpm = m.impressions > 0 ? r2((m.spend / m.impressions) * 1000) : 0;
  m.cpc = m.linkClicks > 0 ? r2(m.spend / m.linkClicks) : null;
  m.frequency = m.reach > 0 ? r2(m.impressions / m.reach) : 0;
  return m;
}

function isoDay(d) { return d.toISOString().slice(0, 10); }
function splitRange(since, until) {
  const a = new Date(since + "T00:00:00Z"), b = new Date(until + "T00:00:00Z");
  const days = Math.round((b - a) / 86400000) + 1;
  if (days < 6) return null;
  const mid = new Date(a.getTime() + Math.floor(days / 2) * 86400000);
  const firstEnd = new Date(mid.getTime() - 86400000);
  return { first: { since: since, until: isoDay(firstEnd) }, second: { since: isoDay(mid), until: until } };
}

function creativeOf(obj) {
  const cr = obj && obj.creative ? obj.creative : null;
  if (!cr) return {};
  let body = cr.body || "", headline = cr.title || "", link = cr.link_url || "", cta = cr.call_to_action_type || "";
  const spec = cr.object_story_spec || null;
  if (spec) {
    const ld = spec.link_data || spec.video_data || spec.photo_data || null;
    if (ld) {
      body = body || ld.message || "";
      headline = headline || ld.name || ld.title || "";
      link = link || ld.link || (ld.call_to_action && ld.call_to_action.value ? ld.call_to_action.value.link || "" : "");
      if (!cta && ld.call_to_action && ld.call_to_action.type) cta = ld.call_to_action.type;
    }
  }
  let format = "image";
  if (cr.video_id || (spec && spec.video_data) || cr.object_type === "VIDEO") format = "video";
  else if (spec && spec.link_data && Array.isArray(spec.link_data.child_attachments)) format = "carousel";
  return {
    thumbnail: cr.thumbnail_url || cr.image_url || "",
    headline: headline, body: body, cta: cta, linkUrl: link, format: format,
  };
}

async function fetchAccount(entry, since, until) {
  const ver = entry.ver, token = entry.token, acct = entry.acct;
  const base = "https://graph.facebook.com/" + ver + "/" + acct;
  const tr = JSON.stringify({ since: since, until: until });
  const out = { acct: acct, ok: true, error: null, tokenExpired: false, campaigns: [], adsets: [], ads: [], trend: [], fatigue: {} };

  try {
    const [campRows, adsetRows, adRows] = await Promise.all([
      getAll(base + "/insights", { level: "campaign", fields: "campaign_id,campaign_name," + INSIGHT_FIELDS, time_range: tr, limit: 500, access_token: token }),
      getAll(base + "/insights", { level: "adset", fields: "campaign_id,adset_id,adset_name," + INSIGHT_FIELDS, time_range: tr, limit: 500, access_token: token }),
      getAll(base + "/insights", { level: "ad", fields: "campaign_id,adset_id,ad_id,ad_name," + INSIGHT_FIELDS, time_range: tr, limit: 500, access_token: token }),
    ]);

    // All campaigns on the account (so "N campaigns" is explainable even for
    // campaigns with zero delivery in the range).
    let allCampaigns = [];
    try {
      allCampaigns = await getAll(base + "/campaigns", { fields: "id,name,effective_status,objective", limit: 500, access_token: token }, 5);
    } catch (e) { allCampaigns = []; }
    const campStatus = {};
    allCampaigns.forEach(function (c) { campStatus[String(c.id)] = { status: c.effective_status || "", name: c.name || "", objective: c.objective || "" }; });

    const adsetIds = adsetRows.map(function (r) { return r.adset_id; });
    const adIds    = adRows.map(function (r) { return r.ad_id; });
    const [adsetObjs, adObjs] = await Promise.all([
      getByIds(ver, adsetIds, "id,name,effective_status,campaign_id", token),
      getByIds(ver, adIds, "id,name,effective_status,adset_id,campaign_id,creative{thumbnail_url,image_url,title,body,call_to_action_type,object_type,object_story_spec,video_id,link_url}", token),
    ]);

    out.campaigns = campRows.map(function (r) {
      const st = campStatus[String(r.campaign_id)] || {};
      return { id: String(r.campaign_id), name: r.campaign_name || st.name || "", status: st.status || "", objective: st.objective || "", metrics: rowMetrics(r) };
    });
    // Campaigns that exist but had no delivery in range — kept for reconciliation.
    out.idleCampaigns = allCampaigns
      .filter(function (c) { return !campRows.some(function (r) { return String(r.campaign_id) === String(c.id); }); })
      .map(function (c) { return { id: String(c.id), name: c.name || "", status: c.effective_status || "" }; });

    out.adsets = adsetRows.map(function (r) {
      const o = adsetObjs[String(r.adset_id)] || {};
      return { id: String(r.adset_id), name: r.adset_name || o.name || "", campaignId: String(r.campaign_id || o.campaign_id || ""), status: o.effective_status || "", metrics: rowMetrics(r) };
    });
    out.ads = adRows.map(function (r) {
      const o = adObjs[String(r.ad_id)] || {};
      return {
        id: String(r.ad_id), name: r.ad_name || o.name || "",
        adsetId: String(r.adset_id || o.adset_id || ""), campaignId: String(r.campaign_id || o.campaign_id || ""),
        status: o.effective_status || "", metrics: rowMetrics(r), creative: creativeOf(o),
      };
    });

    // Fatigue: same ads, first half vs second half of the range.
    const halves = splitRange(since, until);
    if (halves && out.ads.length) {
      try {
        const fields = "ad_id,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpm,actions";
        const [h1, h2] = await Promise.all([
          getAll(base + "/insights", { level: "ad", fields: fields, time_range: JSON.stringify(halves.first), limit: 500, access_token: token }),
          getAll(base + "/insights", { level: "ad", fields: fields, time_range: JSON.stringify(halves.second), limit: 500, access_token: token }),
        ]);
        h1.forEach(function (r) { out.fatigue[String(r.ad_id)] = { first: rowMetrics(r), second: null, halves: halves }; });
        h2.forEach(function (r) {
          const k = String(r.ad_id);
          if (!out.fatigue[k]) out.fatigue[k] = { first: null, second: null, halves: halves };
          out.fatigue[k].second = rowMetrics(r);
        });
      } catch (e) { /* fatigue is optional */ }
    }

    // Trend — hourly when the range is a single day, otherwise daily.
    try {
      if (since === until) {
        const rows = await getAll(base + "/insights", {
          level: "account", fields: "spend,impressions,clicks,inline_link_clicks,actions", time_range: tr,
          breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone", limit: 100, access_token: token,
        });
        out.trend = rows.map(function (r) {
          const h = String(r.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2);
          return { t: since + "T" + h, spend: r2(r.spend), impressions: n(r.impressions), linkClicks: n(r.inline_link_clicks), platformLeads: actionValue(r.actions, LEAD_TYPES) };
        });
        out.trendGranularity = "hour";
      } else {
        const rows = await getAll(base + "/insights", {
          level: "account", fields: "spend,impressions,clicks,inline_link_clicks,actions", time_range: tr,
          time_increment: 1, limit: 500, access_token: token,
        });
        out.trend = rows.map(function (r) {
          return { t: r.date_start, spend: r2(r.spend), impressions: n(r.impressions), linkClicks: n(r.inline_link_clicks), platformLeads: actionValue(r.actions, LEAD_TYPES) };
        });
        out.trendGranularity = "day";
      }
    } catch (e) { out.trend = []; }
  } catch (e) {
    const fe = fbError(e);
    out.ok = false;
    out.error = fe.message;
    out.tokenExpired = fe.code === 190;
  }
  return out;
}

// Main entry. configs = MetaConfig docs (lean, decrypted) for the company.
async function getMetaAdsData({ company, configs, since, until, refresh }) {
  const key = String(company) + "|" + since + "|" + until;
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const accounts = {};
  (configs || []).forEach(function (c) {
    const acct = actId(c.adAccountId);
    if (!acct || !c.adsToken) return;
    // Prefer a config whose token isn't flagged expired.
    if (!accounts[acct] || (accounts[acct].tokenExpired && !c.tokenExpired)) {
      accounts[acct] = { acct: acct, token: c.adsToken, ver: c.graphApiVersion || DEFAULT_VER, tokenExpired: !!c.tokenExpired };
    }
  });
  const entries = Object.keys(accounts).map(function (k) { return accounts[k]; });

  const data = {
    configured: entries.length > 0,
    fetchedAt: new Date().toISOString(),
    range: { since: since, until: until },
    accounts: [], campaigns: [], adsets: [], ads: [], idleCampaigns: [],
    trend: [], trendGranularity: since === until ? "hour" : "day",
    fatigue: {},
    totals: emptyMetrics(),
  };

  const results = await Promise.all(entries.map(function (e) { return fetchAccount(e, since, until); }));
  const trendMap = {};
  results.forEach(function (r) {
    data.accounts.push({ acct: r.acct, ok: r.ok, error: r.error, tokenExpired: r.tokenExpired, campaigns: r.campaigns.length, ads: r.ads.length });
    if (!r.ok) return;
    r.campaigns.forEach(function (c) { c.account = r.acct; data.campaigns.push(c); addMetrics(data.totals, c.metrics); });
    r.adsets.forEach(function (a) { a.account = r.acct; data.adsets.push(a); });
    r.ads.forEach(function (a) { a.account = r.acct; data.ads.push(a); });
    (r.idleCampaigns || []).forEach(function (c) { c.account = r.acct; data.idleCampaigns.push(c); });
    Object.keys(r.fatigue || {}).forEach(function (k) { data.fatigue[k] = r.fatigue[k]; });
    (r.trend || []).forEach(function (t) {
      if (!trendMap[t.t]) trendMap[t.t] = { t: t.t, spend: 0, impressions: 0, linkClicks: 0, platformLeads: 0 };
      trendMap[t.t].spend = r2(trendMap[t.t].spend + t.spend);
      trendMap[t.t].impressions += t.impressions;
      trendMap[t.t].linkClicks += t.linkClicks;
      trendMap[t.t].platformLeads += t.platformLeads;
    });
  });
  data.trend = Object.keys(trendMap).sort().map(function (k) { return trendMap[k]; });
  finalizeMetrics(data.totals);
  // Account-level reach is the sum of campaign reach (upper bound — Meta can't
  // de-duplicate across campaigns without another query). Frequency therefore
  // shown at campaign/ad-set level only.
  data.totals.frequency = null;

  cache.set(key, { at: Date.now(), data: data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

module.exports = { getMetaAdsData, emptyMetrics, addMetrics, finalizeMetrics, actId };
