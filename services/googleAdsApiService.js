// services/googleAdsApiService.js
// ─────────────────────────────────────────────────────────────────────────────
// Google Ads API integration — OAuth 2.0 + GAQL reporting via REST (axios).
//
// App-level env:
//   GOOGLE_ADS_DEVELOPER_TOKEN     required — from your Manager (MCC) API Center
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID   optional — manager id (digits only) if using MCC
//   GOOGLE_ADS_API_VERSION         optional — defaults to v18; bump if deprecated
//
// OAuth creds resolve per-company (GoogleAdsApiConfig) first, else env:
//   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_ADS_OAUTH_REDIRECT_URI  (falls back to GOOGLE_OAUTH_REDIRECT_URI)
//
// No optional-chaining / nullish-coalescing operators — Beautify-safe.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const { encryptToken, decryptToken } = require("../utils/tokenCrypto");
const GoogleAdsConfig = require("../models/GoogleAdsConfig");

const SCOPE = "https://www.googleapis.com/auth/adwords";
const OAUTH_AUTH  = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";

function apiVersion() {
  const v = process.env.GOOGLE_ADS_API_VERSION;
  return v && v.length ? v : "v18";
}
function apiBase() { return "https://googleads.googleapis.com/" + apiVersion(); }

function developerToken() {
  const t = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  return t && t.length ? t : "";
}
function hasDeveloperToken() { return developerToken().length > 0; }

function onlyDigits(s) { return String(s == null ? "" : s).replace(/[^0-9]/g, ""); }

// ── OAuth credential resolution ───────────────────────────────────────────────
function envCreds() {
  const redirect = process.env.GOOGLE_ADS_OAUTH_REDIRECT_URI || process.env.GOOGLE_OAUTH_REDIRECT_URI || "";
  return {
    clientId:     process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    redirectUri:  redirect,
  };
}
function envConfigured() {
  const e = envCreds();
  return !!(e.clientId && e.clientSecret && e.redirectUri);
}
function configHasCreds(config) {
  return !!(config && config.oauthClientId && config.oauthClientSecret && config.oauthRedirectUri);
}
function resolveCreds(config) {
  if (configHasCreds(config)) {
    return {
      clientId:     config.oauthClientId,
      clientSecret: decryptToken(config.oauthClientSecret) || "",
      redirectUri:  config.oauthRedirectUri,
      source:       "db",
    };
  }
  const e = envCreds();
  return { clientId: e.clientId, clientSecret: e.clientSecret, redirectUri: e.redirectUri, source: "env" };
}
function isConfigured(config) {
  if (configHasCreds(config)) return true;
  return envConfigured();
}
function assertCreds(creds) {
  if (!creds || !creds.clientId || !creds.clientSecret || !creds.redirectUri) {
    const e = new Error("Google OAuth is not configured (missing Client ID / Secret / Redirect URI).");
    e.code = "OAUTH_NOT_CONFIGURED"; throw e;
  }
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
function buildAuthUrl(state, creds) {
  const c = creds || resolveCreds(null);
  assertCreds(c);
  const params = new URLSearchParams({
    client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code",
    scope: SCOPE, access_type: "offline", prompt: "consent",
    include_granted_scopes: "true", state,
  });
  return OAUTH_AUTH + "?" + params.toString();
}
async function exchangeCodeForTokens(code, creds) {
  const c = creds || resolveCreds(null);
  assertCreds(c);
  const { data } = await axios.post(OAUTH_TOKEN, new URLSearchParams({
    code, client_id: c.clientId, client_secret: c.clientSecret,
    redirect_uri: c.redirectUri, grant_type: "authorization_code",
  }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return data;
}
async function refreshAccessToken(refreshToken, creds) {
  const c = creds || resolveCreds(null);
  assertCreds(c);
  const { data } = await axios.post(OAUTH_TOKEN, new URLSearchParams({
    refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret,
    grant_type: "refresh_token",
  }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return data;
}
async function getValidAccessToken(config) {
  const now = Date.now();
  const cached = decryptToken(config.accessToken);
  if (cached && config.accessTokenExpiry && new Date(config.accessTokenExpiry).getTime() - 60000 > now) {
    return cached;
  }
  const refresh = decryptToken(config.refreshToken);
  if (!refresh) { const e = new Error("Google Ads is not connected (no refresh token)."); e.code = "NOT_CONNECTED"; throw e; }
  const tok = await refreshAccessToken(refresh, resolveCreds(config));
  config.accessToken = encryptToken(tok.access_token);
  config.accessTokenExpiry = new Date(now + (tok.expires_in || 3600) * 1000);
  await config.save();
  return tok.access_token;
}
async function fetchUserEmail(accessToken) {
  try {
    const { data } = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: "Bearer " + accessToken } });
    return (data && data.email) ? data.email : null;
  } catch (e) { return null; }
}

// ── Google Ads REST helpers ───────────────────────────────────────────────────
function adsHeaders(accessToken, loginCustomerId) {
  const h = {
    "Authorization": "Bearer " + accessToken,
    "developer-token": developerToken(),
    "Content-Type": "application/json",
  };
  const envLogin = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "";
  const login = onlyDigits(loginCustomerId || envLogin);
  if (login) h["login-customer-id"] = login;
  return h;
}

function assertDevToken() {
  if (!hasDeveloperToken()) {
    const e = new Error("Google Ads developer token is not configured on the server (GOOGLE_ADS_DEVELOPER_TOKEN).");
    e.code = "NO_DEV_TOKEN"; throw e;
  }
}

// List the Google Ads accounts the connected login can access.
async function listAccessibleCustomers(accessToken) {
  assertDevToken();
  const url = apiBase() + "/customers:listAccessibleCustomers";
  const { data } = await axios.get(url, { headers: adsHeaders(accessToken, null) });
  const names = (data && data.resourceNames) ? data.resourceNames : [];
  const ids = names.map(function (n) { return String(n).replace("customers/", ""); });

  // Best-effort: fetch a descriptive name for each account.
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let label = id;
    try {
      const q = "SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1";
      const res = await gaqlSearchRaw(accessToken, id, id, q);
      const rows = (res && res.results) ? res.results : [];
      if (rows.length && rows[0].customer && rows[0].customer.descriptiveName) label = rows[0].customer.descriptiveName;
    } catch (e) { /* keep id as label */ }
    out.push({ customerId: id, customerName: label });
  }
  return out;
}

// Low-level GAQL search against a specific customer id.
async function gaqlSearchRaw(accessToken, customerId, loginCustomerId, query) {
  const cid = onlyDigits(customerId);
  const url = apiBase() + "/customers/" + cid + "/googleAds:search";
  const results = [];
  let pageToken = null;
  for (;;) {
    const body = { query: query };
    if (pageToken) body.pageToken = pageToken;
    const resp = await axios.post(url, body, { headers: adsHeaders(accessToken, loginCustomerId), timeout: 30000 });
    const data = resp.data || {};
    const rows = data.results ? data.results : [];
    for (let i = 0; i < rows.length; i++) results.push(rows[i]);
    if (data.nextPageToken) { pageToken = data.nextPageToken; } else { break; }
  }
  return { results: results };
}

async function gaqlSearch(config, accessToken, query) {
  return gaqlSearchRaw(accessToken, config.customerId, config.loginCustomerId, query);
}

// ── Metric helpers ────────────────────────────────────────────────────────────
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const microsToCur = (m) => round2((Number(m) || 0) / 1000000);
const numOf = (v) => (v == null ? 0 : Number(v));
function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }

// ── Report builder (campaign + device + daily time-series) ────────────────────
async function buildReport(config, opts) {
  const from = opts && opts.from ? opts.from : isoDate(Date.now() - 30 * 86400000);
  const to   = opts && opts.to   ? opts.to   : isoDate(Date.now());
  if (!config.customerId) { const e = new Error("No Google Ads account selected."); e.code = "NO_ACCOUNT"; throw e; }
  const token = await getValidAccessToken(config);

  const dateWhere = " WHERE segments.date BETWEEN '" + from + "' AND '" + to + "'";

  // Per-campaign metrics
  const campQ =
    "SELECT campaign.id, campaign.name, campaign.status, " +
    "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, " +
    "metrics.conversions_value, metrics.ctr, metrics.average_cpc, metrics.video_views " +
    "FROM campaign" + dateWhere + " ORDER BY metrics.cost_micros DESC";

  // Device breakdown
  const devQ =
    "SELECT segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions " +
    "FROM campaign" + dateWhere;

  // Daily time-series
  const dayQ =
    "SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.video_views " +
    "FROM campaign" + dateWhere + " ORDER BY segments.date";

  const settle = async (fn) => { try { return await fn(); } catch (e) {
    const m = e && e.response && e.response.data && e.response.data.error ? e.response.data.error.message : e.message;
    return { __error: m };
  } };

  const [campRes, devRes, dayRes] = await Promise.all([
    settle(function () { return gaqlSearch(config, token, campQ); }),
    settle(function () { return gaqlSearch(config, token, devQ); }),
    settle(function () { return gaqlSearch(config, token, dayQ); }),
  ]);

  const totals = { impressions: 0, clicks: 0, cost: 0, conversions: 0, conversionsValue: 0, videoViews: 0 };
  const campaigns = [];
  const campRows = (campRes && campRes.results) ? campRes.results : [];
  for (let i = 0; i < campRows.length; i++) {
    const r = campRows[i];
    const c = r.campaign || {}, m = r.metrics || {};
    const impressions = numOf(m.impressions), clicks = numOf(m.clicks);
    const cost = microsToCur(m.costMicros), conv = round2(numOf(m.conversions));
    const views = numOf(m.videoViews);
    const convValue = round2(numOf(m.conversionsValue)); // conversions_value is a plain double, not micros
    totals.impressions += impressions; totals.clicks += clicks; totals.cost += cost;
    totals.conversions += conv; totals.conversionsValue += convValue; totals.videoViews += views;
    campaigns.push({
      campaignId: c.id ? String(c.id) : "", campaignName: c.name || "", status: c.status || "",
      impressions: impressions, clicks: clicks, cost: round2(cost), conversions: conv,
      conversionsValue: convValue, videoViews: views,
      ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
      avgCpc: clicks > 0 ? round2(cost / clicks) : 0,
      cpm: impressions > 0 ? round2((cost / impressions) * 1000) : 0,
      costPerConversion: conv > 0 ? round2(cost / conv) : null,
    });
  }

  const devices = [];
  const devRows = (devRes && devRes.results) ? devRes.results : [];
  const devMap = {};
  for (let i = 0; i < devRows.length; i++) {
    const r = devRows[i]; const seg = r.segments || {}, m = r.metrics || {};
    const key = seg.device || "UNKNOWN";
    if (!devMap[key]) devMap[key] = { device: key, impressions: 0, clicks: 0, cost: 0, conversions: 0 };
    devMap[key].impressions += numOf(m.impressions);
    devMap[key].clicks += numOf(m.clicks);
    devMap[key].cost += microsToCur(m.costMicros);
    devMap[key].conversions += round2(numOf(m.conversions));
  }
  Object.keys(devMap).forEach(function (k) {
    const d = devMap[k];
    devices.push({ device: d.device, impressions: d.impressions, clicks: d.clicks, cost: round2(d.cost), conversions: round2(d.conversions),
      ctr: d.impressions > 0 ? round2((d.clicks / d.impressions) * 100) : 0 });
  });

  const timeseries = [];
  const dayRows = (dayRes && dayRes.results) ? dayRes.results : [];
  const dayMap = {};
  for (let i = 0; i < dayRows.length; i++) {
    const r = dayRows[i]; const seg = r.segments || {}, m = r.metrics || {};
    const d = seg.date || "";
    if (!dayMap[d]) dayMap[d] = { date: d, impressions: 0, clicks: 0, cost: 0, conversions: 0, videoViews: 0 };
    dayMap[d].impressions += numOf(m.impressions);
    dayMap[d].clicks += numOf(m.clicks);
    dayMap[d].cost += microsToCur(m.costMicros);
    dayMap[d].conversions += round2(numOf(m.conversions));
    dayMap[d].videoViews += numOf(m.videoViews);
  }
  Object.keys(dayMap).sort().forEach(function (k) {
    const d = dayMap[k]; d.cost = round2(d.cost); d.conversions = round2(d.conversions); timeseries.push(d);
  });

  const overall = {
    impressions: totals.impressions,
    clicks: totals.clicks,
    cost: round2(totals.cost),
    conversions: round2(totals.conversions),
    conversionsValue: round2(totals.conversionsValue),
    videoViews: totals.videoViews,
    ctr: totals.impressions > 0 ? round2((totals.clicks / totals.impressions) * 100) : 0,
    avgCpc: totals.clicks > 0 ? round2(totals.cost / totals.clicks) : 0,
    cpm: totals.impressions > 0 ? round2((totals.cost / totals.impressions) * 1000) : 0,
    costPerConversion: totals.conversions > 0 ? round2(totals.cost / totals.conversions) : null,
    roas: totals.cost > 0 ? round2(totals.conversionsValue / totals.cost) : null,
  };

  return {
    range: { from: from, to: to },
    account: { customerId: config.customerId, customerName: config.customerName },
    overall: overall, campaigns: campaigns, devices: devices, timeseries: timeseries,
    partialErrors: {
      campaigns: campRes && campRes.__error ? campRes.__error : null,
      devices: devRes && devRes.__error ? devRes.__error : null,
      timeseries: dayRes && dayRes.__error ? dayRes.__error : null,
    },
  };
}

// ── Sync live metrics into the existing per-campaign GoogleAdsConfig docs ──────
// So the existing Google Ads business dashboard becomes live instead of manual.
// Matches by (company, campaignId). Auto-creates a minimal config for campaigns
// that don't have one yet (generates a googleKey so the required+unique field is set).
async function syncToConfigs(company, config, opts) {
  const report = await buildReport(config, opts);
  const campaigns = report.campaigns || [];
  let updated = 0, created = 0;

  for (let i = 0; i < campaigns.length; i++) {
    const c = campaigns[i];
    if (!c.campaignId) continue;
    const existing = await GoogleAdsConfig.findOne({ company: company, campaignId: String(c.campaignId) });
    if (existing) {
      existing.impressions = c.impressions;
      existing.clicks = c.clicks;
      existing.cost = c.cost;
      if (!existing.campaignName && c.campaignName) existing.campaignName = c.campaignName;
      await existing.save();
      updated++;
    } else {
      const key = "gads-" + String(c.campaignId);
      try {
        await GoogleAdsConfig.create({
          company: company,
          campaignName: c.campaignName || ("Campaign " + c.campaignId),
          googleKey: key,
          campaignId: String(c.campaignId),
          impressions: c.impressions, clicks: c.clicks, cost: c.cost,
          isActive: true,
        });
        created++;
      } catch (e) { /* duplicate key or race — skip */ }
    }
  }

  config.lastSyncedAt = new Date();
  await config.save();
  return { updated: updated, created: created, campaigns: campaigns.length, range: report.range };
}

module.exports = {
  // config helpers
  envCreds, envConfigured, configHasCreds, resolveCreds, isConfigured,
  hasDeveloperToken, developerToken, apiVersion,
  // oauth
  buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, getValidAccessToken, fetchUserEmail,
  // ads api
  listAccessibleCustomers, gaqlSearch, buildReport, syncToConfigs,
};
