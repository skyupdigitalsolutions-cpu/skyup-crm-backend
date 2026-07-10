// services/ga4Service.js
// ─────────────────────────────────────────────────────────────────────────────
// Google Analytics 4 integration — OAuth 2.0 + Analytics Data API (v1beta).
// Uses axios (no googleapis SDK needed). One shared OAuth app (env creds);
// each company connects their own GA account and selects a GA4 property.
//
// Required env:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REDIRECT_URI     e.g. https://<your-api-host>/api/google-analytics/callback
//   GA_TOKEN_ENCRYPTION_KEY       strong secret for encrypting refresh tokens
//   GA_POST_CONNECT_REDIRECT      (optional) frontend URL to return to after connect
//
// Google Cloud setup (once): enable "Google Analytics Data API" + "Analytics
// Admin API"; OAuth consent screen with scope analytics.readonly; Web OAuth
// client with the redirect URI above.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const { encryptToken, decryptToken } = require("../utils/tokenCrypto");
const { callGrok } = require("../utils/leadActionSummary");

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const OAUTH_AUTH  = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const ADMIN_API   = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_API    = "https://analyticsdata.googleapis.com/v1beta";

const clientId     = () => process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = () => process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const redirectUri  = () => process.env.GOOGLE_OAUTH_REDIRECT_URI;

function assertConfigured() {
  if (!clientId() || !clientSecret() || !redirectUri()) {
    const e = new Error("Google OAuth is not configured on the server (missing GOOGLE_OAUTH_CLIENT_ID / SECRET / REDIRECT_URI).");
    e.code = "OAUTH_NOT_CONFIGURED";
    throw e;
  }
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
function buildAuthUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id:     clientId(),
    redirect_uri:  redirectUri(),
    response_type: "code",
    scope:         SCOPE,
    access_type:   "offline",     // get a refresh token
    prompt:        "consent",     // ensure refresh token is returned every time
    include_granted_scopes: "true",
    state,
  });
  return `${OAUTH_AUTH}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  assertConfigured();
  const { data } = await axios.post(OAUTH_TOKEN, new URLSearchParams({
    code,
    client_id:     clientId(),
    client_secret: clientSecret(),
    redirect_uri:  redirectUri(),
    grant_type:    "authorization_code",
  }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return data; // { access_token, refresh_token, expires_in, scope, token_type, id_token? }
}

async function refreshAccessToken(refreshToken) {
  assertConfigured();
  const { data } = await axios.post(OAUTH_TOKEN, new URLSearchParams({
    refresh_token: refreshToken,
    client_id:     clientId(),
    client_secret: clientSecret(),
    grant_type:    "refresh_token",
  }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return data; // { access_token, expires_in, scope, token_type }
}

// Return a valid access token for a config, refreshing + persisting if needed.
async function getValidAccessToken(config) {
  const now = Date.now();
  const cachedTok = decryptToken(config.accessToken);
  if (cachedTok && config.accessTokenExpiry && new Date(config.accessTokenExpiry).getTime() - 60000 > now) {
    return cachedTok;
  }
  const refresh = decryptToken(config.refreshToken);
  if (!refresh) {
    const e = new Error("Google Analytics is not connected (no refresh token).");
    e.code = "NOT_CONNECTED";
    throw e;
  }
  const tok = await refreshAccessToken(refresh);
  config.accessToken       = encryptToken(tok.access_token);
  config.accessTokenExpiry = new Date(now + (tok.expires_in || 3600) * 1000);
  await config.save();
  return tok.access_token;
}

// Fetch the Google account email (for display) using the OpenID userinfo endpoint.
async function fetchUserEmail(accessToken) {
  try {
    const { data } = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return data?.email || null;
  } catch { return null; }
}

// ── GA4 property discovery (Admin API) ────────────────────────────────────────
async function listProperties(accessToken) {
  const { data } = await axios.get(`${ADMIN_API}/accountSummaries`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params:  { pageSize: 200 },
  });
  const out = [];
  for (const acct of data.accountSummaries || []) {
    for (const p of acct.propertySummaries || []) {
      out.push({
        propertyId:   String(p.property || "").replace("properties/", ""),
        propertyName: p.displayName || p.property,
        account:      acct.displayName || "",
      });
    }
  }
  return out;
}

// ── Low-level runReport ───────────────────────────────────────────────────────
async function runReport(propertyId, accessToken, body) {
  const { data } = await axios.post(
    `${DATA_API}/properties/${propertyId}:runReport`,
    body,
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, timeout: 30000 }
  );
  return data;
}

// Helpers to read GA4 report rows.
const metricVal = (row, i) => Number(row.metricValues?.[i]?.value || 0);
const dimVal    = (row, i) => row.dimensionValues?.[i]?.value || "";
const round2    = (v) => Math.round((Number(v) || 0) * 100) / 100;
const pctChange = (cur, prev) => (prev > 0 ? round2(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0));

// ── Section builders ──────────────────────────────────────────────────────────

// Overview KPIs with previous-period comparison (two date ranges).
async function buildOverview(propertyId, token, from, to, prevFrom, prevTo) {
  const metrics = [
    "totalUsers", "newUsers", "activeUsers", "sessions", "engagedSessions",
    "engagementRate", "bounceRate", "userEngagementDuration", "averageSessionDuration",
    "conversions", "eventCount",
  ].map((name) => ({ name }));

  const data = await runReport(propertyId, token, {
    dateRanges: [
      { startDate: from,     endDate: to,     name: "current" },
      { startDate: prevFrom, endDate: prevTo, name: "previous" },
    ],
    metrics,
  });

  // With multiple dateRanges and no dimensions, GA4 returns one row per range,
  // tagged by a "dateRange" dimension it adds automatically.
  const rows = data.rows || [];
  const pick = (rangeName) => rows.find((r) => (r.dimensionValues?.[0]?.value || "").includes(rangeName)) || rows[rangeName === "current" ? 0 : 1] || { metricValues: [] };
  const cur = pick("current"), prev = pick("previous");

  const labels = [
    ["Users", 0, "int", "up"], ["New Users", 1, "int", "up"], ["Active Users", 2, "int", "up"],
    ["Sessions", 3, "int", "up"], ["Engaged Sessions", 4, "int", "up"],
    ["Engagement Rate", 5, "pct", "up"], ["Bounce Rate", 6, "pct", "down"],
    ["Avg Engagement Time", 7, "dur_total", "up"], ["Avg Session Duration", 8, "dur", "up"],
    ["Conversions", 9, "int", "up"], ["Total Events", 10, "int", "up"],
  ];

  return labels.map(([label, i, fmt, better]) => {
    let c = metricVal(cur, i), p = metricVal(prev, i);
    // engagementRate/bounceRate come as 0..1 fractions
    if (fmt === "pct") { c = round2(c * 100); p = round2(p * 100); }
    if (fmt === "dur_total") { // userEngagementDuration is total secs → per active user avg
      const cu = metricVal(cur, 2) || 1, pu = metricVal(prev, 2) || 1;
      c = round2(c / cu); p = round2(p / pu);
    }
    if (fmt === "dur") { c = round2(c); p = round2(p); }
    const delta = pctChange(c, p);
    const good = better === "down" ? delta < 0 : delta > 0;
    return {
      label, value: c, prev: p, format: fmt === "dur_total" ? "dur" : fmt,
      deltaPct: delta, color: Math.abs(delta) < 2 ? "orange" : (good ? "green" : "red"),
    };
  });
}

async function buildTrafficSources(propertyId, token, from, to) {
  const data = await runReport(propertyId, token, {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }],
    metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "engagementRate" }, { name: "bounceRate" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 25,
  });
  return (data.rows || []).map((r) => ({
    source: dimVal(r, 0) || "(direct)",
    medium: dimVal(r, 1) || "(none)",
    users: metricVal(r, 0), sessions: metricVal(r, 1),
    engagementRate: round2(metricVal(r, 2) * 100), bounceRate: round2(metricVal(r, 3) * 100),
    conversions: metricVal(r, 4),
  }));
}

async function buildLandingPages(propertyId, token, from, to) {
  const data = await runReport(propertyId, token, {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "landingPagePlusQueryString" }],
    metrics: [
      { name: "screenPageViews" }, { name: "totalUsers" }, { name: "sessions" },
      { name: "userEngagementDuration" }, { name: "bounceRate" }, { name: "conversions" },
    ],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 50,
  });
  return (data.rows || []).map((r) => {
    const sessions = metricVal(r, 2), users = metricVal(r, 1), conv = metricVal(r, 5);
    return {
      page: dimVal(r, 0) || "/",
      views: metricVal(r, 0), users, sessions,
      avgEngagementTime: users > 0 ? round2(metricVal(r, 3) / users) : 0,
      bounceRate: round2(metricVal(r, 4) * 100),
      conversions: conv,
      conversionRate: sessions > 0 ? round2((conv / sessions) * 100) : 0,
    };
  });
}

async function buildEvents(propertyId, token, from, to) {
  const data = await runReport(propertyId, token, {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "eventCount" }, { name: "totalUsers" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
    limit: 40,
  });
  return (data.rows || []).map((r) => ({
    event: dimVal(r, 0), count: metricVal(r, 0), users: metricVal(r, 1), conversions: metricVal(r, 2),
  }));
}

async function buildDevices(propertyId, token, from, to) {
  const data = await runReport(propertyId, token, {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "deviceCategory" }],
    metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "bounceRate" }, { name: "engagementRate" }, { name: "conversions" }],
  });
  return (data.rows || []).map((r) => ({
    device: dimVal(r, 0), users: metricVal(r, 0), sessions: metricVal(r, 1),
    bounceRate: round2(metricVal(r, 2) * 100), engagementRate: round2(metricVal(r, 3) * 100),
    conversions: metricVal(r, 4),
  }));
}

async function buildGeo(propertyId, token, from, to) {
  const data = await runReport(propertyId, token, {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "country" }, { name: "region" }, { name: "city" }],
    metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "conversions" }, { name: "engagementRate" }],
    orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
    limit: 50,
  });
  return (data.rows || []).map((r) => ({
    country: dimVal(r, 0), state: dimVal(r, 1), city: dimVal(r, 2),
    users: metricVal(r, 0), sessions: metricVal(r, 1), conversions: metricVal(r, 2),
    engagementRate: round2(metricVal(r, 3) * 100),
  }));
}

async function buildBrowserOs(propertyId, token, from, to) {
  const data = await runReport(propertyId, token, {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "browser" }, { name: "operatingSystem" }, { name: "deviceCategory" }],
    metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "conversions" }],
    orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
    limit: 40,
  });
  return (data.rows || []).map((r) => ({
    browser: dimVal(r, 0), os: dimVal(r, 1), device: dimVal(r, 2),
    users: metricVal(r, 0), sessions: metricVal(r, 1), conversions: metricVal(r, 2),
  }));
}

async function buildTimeseries(propertyId, token, from, to) {
  const data = await runReport(propertyId, token, {
    dateRanges: [{ startDate: from, endDate: to }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "conversions" }, { name: "engagementRate" }],
    orderBys: [{ dimension: { dimensionName: "date" } }],
    limit: 400,
  });
  return (data.rows || []).map((r) => {
    const d = dimVal(r, 0); // YYYYMMDD
    return {
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      users: metricVal(r, 0), sessions: metricVal(r, 1), conversions: metricVal(r, 2),
      engagementRate: round2(metricVal(r, 3) * 100),
    };
  });
}

// ── Assemble the full dashboard ───────────────────────────────────────────────
function prevRange(from, to) {
  const f = new Date(from), t = new Date(to);
  const span = Math.max(1, t - f);
  const pt = new Date(f.getTime() - 86400000);
  const pf = new Date(f.getTime() - span - 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { prevFrom: iso(pf), prevTo: iso(pt) };
}

async function buildDashboard(config, { from, to }) {
  const token = await getValidAccessToken(config);
  const propertyId = config.propertyId;
  if (!propertyId) { const e = new Error("No GA4 property selected."); e.code = "NO_PROPERTY"; throw e; }
  const { prevFrom, prevTo } = prevRange(from, to);

  // Run in parallel; if one section fails, keep the rest.
  const settle = async (fn) => { try { return await fn(); } catch (e) { return { __error: e?.response?.data?.error?.message || e.message }; } };

  const [overview, trafficSources, landingPages, events, devices, geo, browserOs, timeseries] = await Promise.all([
    settle(() => buildOverview(propertyId, token, from, to, prevFrom, prevTo)),
    settle(() => buildTrafficSources(propertyId, token, from, to)),
    settle(() => buildLandingPages(propertyId, token, from, to)),
    settle(() => buildEvents(propertyId, token, from, to)),
    settle(() => buildDevices(propertyId, token, from, to)),
    settle(() => buildGeo(propertyId, token, from, to)),
    settle(() => buildBrowserOs(propertyId, token, from, to)),
    settle(() => buildTimeseries(propertyId, token, from, to)),
  ]);

  return {
    range: { from, to }, prevRange: { from: prevFrom, to: prevTo },
    property: { id: propertyId, name: config.propertyName },
    overview, trafficSources, landingPages, events, devices, geo, browserOs, timeseries,
    aiAnalysis: null,
  };
}

// ── AI website analysis ───────────────────────────────────────────────────────
async function runWebsiteAI(dash) {
  const kpi = (arr) => Array.isArray(arr) ? arr.map((k) => `${k.label}: ${k.value}${k.format === "pct" ? "%" : ""} (${k.deltaPct >= 0 ? "+" : ""}${k.deltaPct}%)`).join(", ") : "n/a";
  const L = [];
  L.push(`Overview — ${kpi(dash.overview)}`);
  if (Array.isArray(dash.landingPages)) {
    L.push("", "Top landing pages (page | sessions | bounce% | conv%):");
    dash.landingPages.slice(0, 12).forEach((p) => L.push(`- ${p.page} | ${p.sessions} | ${p.bounceRate}% | ${p.conversionRate}%`));
  }
  if (Array.isArray(dash.trafficSources)) {
    L.push("", "Traffic sources (source/medium | sessions | conv):");
    dash.trafficSources.slice(0, 10).forEach((s) => L.push(`- ${s.source}/${s.medium} | ${s.sessions} | ${s.conversions}`));
  }
  if (Array.isArray(dash.devices)) {
    L.push("", "Devices:");
    dash.devices.forEach((d) => L.push(`- ${d.device}: users ${d.users}, bounce ${d.bounceRate}%, conv ${d.conversions}`));
  }

  const systemPrompt =
    "You are a web-analytics consultant reviewing a website's Google Analytics 4 data. " +
    "You are given overview KPIs (with % change vs the previous period), landing pages (bounce %, conversion %), " +
    "traffic sources, and device performance. Identify high-bounce/low-engagement pages, best pages & sources, " +
    "device patterns, and concrete conversion/CTA/content improvements. Respond in STRICT JSON only (no markdown):\n" +
    "{\n" +
    '  "summary": "3-4 sentence overview",\n' +
    '  "problems": ["specific, data-backed problems"],\n' +
    '  "recommendations": ["specific actions, highest impact first"],\n' +
    '  "expectedImpact": "what improving these would achieve",\n' +
    '  "priority": "High|Medium|Low"\n' +
    "}\nKeep each item under 160 characters.";

  let raw, attempt = 0;
  for (;;) {
    try { raw = await callGrok(systemPrompt, L.join("\n"), 1300); break; }
    catch (e) {
      if (e?.response?.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); attempt++; continue; }
      throw e;
    }
  }
  const cleaned = (raw || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); }
  catch { return { summary: cleaned, problems: [], recommendations: [], expectedImpact: "", priority: "Medium" }; }
}

module.exports = {
  buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, getValidAccessToken,
  fetchUserEmail, listProperties, buildDashboard, runWebsiteAI, assertConfigured,
};