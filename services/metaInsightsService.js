// services/metaInsightsService.js
// ─────────────────────────────────────────────────────────────────────────────
// META AD PERFORMANCE (Insights API)
//
// For each MetaConfig that has an adAccountId + adsToken, pulls spend / CPM /
// CPC / CTR / impressions / reach from the Meta Ads Insights API, joins the
// CRM lead count for the same period to compute COST PER LEAD, and runs a
// setup-issue health check so admins can spot misconfigured campaigns.
//
// Credentials live on MetaConfig (per campaign / ad set):
//   adAccountId  "act_1234567890"
//   adsToken     token with ads_read on that account
//   metaAdsetId / metaCampaignId  (optional) narrow insights to one ad set/campaign
//
// No new env/creds needed beyond what you paste into the config. If a config has
// no adAccountId/adsToken, it's reported as "not configured" (not an error).
// ─────────────────────────────────────────────────────────────────────────────

const axios     = require("axios");
const MetaConfig = require("../models/MetaConfig");
const Lead       = require("../models/Leads");
const { callGrok } = require("../utils/leadActionSummary");

const DEFAULT_VER = process.env.META_GRAPH_API_VERSION || "v21.0";

const num = (v) => (v == null || v === "" ? 0 : Number(v));

function dateRange(from, to) {
  const toD   = to   ? new Date(to)   : new Date();
  const fromD = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { since: fmt(fromD), until: fmt(toD), fromD, toD };
}

// ── Fetch insights for one config ─────────────────────────────────────────────
async function fetchInsightsForConfig(cfg, since, until) {
  const ver   = cfg.graphApiVersion || DEFAULT_VER;
  const token = cfg.adsToken;
  const acct  = cfg.adAccountId;

  if (!acct || !token) {
    return { configured: false };
  }

  // Scope: ad set > campaign > whole account.
  let node = acct;
  let level = "account";
  if (cfg.metaAdsetId)        { node = cfg.metaAdsetId;    level = "adset"; }
  else if (cfg.metaCampaignId){ node = cfg.metaCampaignId; level = "campaign"; }

  const url = `https://graph.facebook.com/${ver}/${node}/insights`;
  const params = {
    fields: "spend,impressions,reach,clicks,cpm,cpc,ctr,frequency",
    time_range: JSON.stringify({ since, until }),
    access_token: token,
  };

  try {
    const { data } = await axios.get(url, { params, timeout: 20000 });
    const row = (data && data.data && data.data[0]) || null;
    if (!row) {
      return { configured: true, hasData: false, level,
        metrics: { spend: 0, impressions: 0, reach: 0, clicks: 0, cpm: 0, cpc: 0, ctr: 0, frequency: 0 } };
    }
    return {
      configured: true,
      hasData: true,
      level,
      metrics: {
        spend:       num(row.spend),
        impressions: num(row.impressions),
        reach:       num(row.reach),
        clicks:      num(row.clicks),
        cpm:         num(row.cpm),
        cpc:         num(row.cpc),
        ctr:         num(row.ctr),
        frequency:   num(row.frequency),
      },
    };
  } catch (e) {
    const fb = e?.response?.data?.error;
    return {
      configured: true,
      hasData: false,
      error: fb?.message || e.message,
      errorCode: fb?.code || null,
      // Common, actionable cases surfaced explicitly:
      needsAdsRead: fb?.code === 100 || /ads_read|permission/i.test(fb?.message || ""),
      tokenExpired: fb?.code === 190,
    };
  }
}

// ── CRM lead count for this config's campaign/ad set in the period ────────────
async function leadCountForConfig(cfg, fromD, toD) {
  const q = {
    company: cfg.company,
    mergedInto: null,
    createdAt: { $gte: fromD, $lte: toD },
  };
  // Match leads to this config by campaign / ad set name (how leads are tagged).
  if (cfg.parentCampaignName || cfg.campaignName) {
    q.campaign = cfg.parentCampaignName || cfg.campaignName;
  }
  try {
    return await Lead.countDocuments(q);
  } catch {
    return 0;
  }
}

// ── Setup-issue detector ──────────────────────────────────────────────────────
function detectIssues({ configured, hasData, metrics, error, needsAdsRead, tokenExpired }, leadCount) {
  const issues = [];
  if (!configured) {
    issues.push({ level: "info", msg: "No ad account / ads_read token set for this campaign — add them to see metrics." });
    return issues;
  }
  if (tokenExpired) { issues.push({ level: "error", msg: "Ads token expired or invalid — generate a new ads_read token." }); return issues; }
  if (needsAdsRead) { issues.push({ level: "error", msg: "Token lacks ads_read permission on this ad account." }); return issues; }
  if (error)        { issues.push({ level: "error", msg: `Meta API error: ${error}` }); return issues; }

  const m = metrics || {};
  if (m.spend > 0 && m.impressions === 0) issues.push({ level: "warn", msg: "Spend recorded but zero impressions — check ad delivery / review status." });
  if (m.impressions > 0 && m.clicks === 0) issues.push({ level: "warn", msg: "Impressions but no clicks — creative or targeting may be off." });
  if (m.spend > 0 && leadCount === 0)      issues.push({ level: "warn", msg: "Spend recorded but no CRM leads captured — check lead form / webhook mapping." });
  if (m.spend === 0 && m.impressions === 0) issues.push({ level: "info", msg: "No spend or delivery in this period — campaign may be paused or budget exhausted." });
  if (m.impressions >= 1000 && m.ctr > 0 && m.ctr < 0.5) issues.push({ level: "warn", msg: `Low CTR (${m.ctr}%) — consider refreshing creative or targeting.` });
  if (m.frequency >= 4) issues.push({ level: "warn", msg: `High frequency (${m.frequency}) — audience may be fatigued; widen targeting.` });

  if (issues.length === 0) issues.push({ level: "ok", msg: "No setup issues detected." });
  return issues;
}

// ── Public: full report for a company ─────────────────────────────────────────
async function getMetaInsightsReport({ company, from, to, withAI = true }) {
  const { since, until, fromD, toD } = dateRange(from, to);

  const configs = await Lead.db.model("MetaConfig").find({ company, isActive: true }).lean();

  const campaigns = [];
  const totals = { spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0 };

  for (const cfg of configs) {
    const insights = await fetchInsightsForConfig(cfg, since, until);
    const leadCount = await leadCountForConfig(cfg, fromD, toD);
    const issues = detectIssues(insights, leadCount);

    const m = insights.metrics || { spend: 0, impressions: 0, reach: 0, clicks: 0, cpm: 0, cpc: 0, ctr: 0, frequency: 0 };
    const costPerLead = leadCount > 0 ? Math.round((m.spend / leadCount) * 100) / 100 : null;

    if (insights.configured && insights.hasData) {
      totals.spend       += m.spend;
      totals.impressions += m.impressions;
      totals.reach       += m.reach;
      totals.clicks      += m.clicks;
    }
    totals.leads += leadCount;

    campaigns.push({
      configId:     cfg._id,
      campaignName: cfg.parentCampaignName || cfg.campaignName,
      adSetName:    cfg.adSetName || "",
      configured:   !!insights.configured,
      metrics:      m,
      leads:        leadCount,
      costPerLead,
      issues,
    });
  }

  const overallCPL = totals.leads > 0 ? Math.round((totals.spend / totals.leads) * 100) / 100 : null;

  const result = {
    range: { from: fromD, to: toD },
    totals: { ...totals, costPerLead: overallCPL },
    campaigns,
    aiAnalysis: null,
  };

  // ── AI analysis + improvement suggestions ───────────────────────────────────
  // Only analyse campaigns that actually returned data; skip if none configured.
  const configured = campaigns.filter((c) => c.configured && c.metrics && (c.metrics.spend > 0 || c.metrics.impressions > 0));
  if (withAI && configured.length > 0) {
    try {
      result.aiAnalysis = await runMetaAIAnalysis(configured, result.totals);
    } catch (e) {
      result.aiAnalysisError = e.code === "GROK_PAYLOAD_TOO_LARGE"
        ? "Too much data to analyse at once — narrow the date range."
        : (e.message || "AI analysis unavailable right now.");
    }
  }

  return result;
}

// Build an AI performance review + improvement suggestions from the ad metrics.
async function runMetaAIAnalysis(campaigns, totals) {
  const systemPrompt =
    "You are a paid-media (Meta Ads) performance analyst. You are given ad metrics " +
    "per campaign (spend, impressions, reach, clicks, CPM, CPC, CTR, frequency), the " +
    "CRM leads captured, and the cost per lead. Analyse performance and respond in " +
    "STRICT JSON only (no markdown), shape:\n" +
    "{\n" +
    '  "summary": "2-3 sentence overview of overall ad performance & efficiency",\n' +
    '  "topPerformers": [{"campaign":"...","why":"what is working"}],\n' +
    '  "underperformers": [{"campaign":"...","issue":"what is wrong (high CPL, low CTR, no leads, fatigue, etc.)"}],\n' +
    '  "suggestions": ["specific, actionable improvements tied to the data"]\n' +
    "}\n" +
    "Judge CTR (<0.5% weak, >1.5% strong), cost per lead (flag the most expensive), " +
    "frequency (>4 = fatigue), and spend-with-no-leads. Be specific and practical, " +
    "referencing campaign names. Keep it concise.";

  const lines = [
    `Overall: spend ₹${totals.spend}, leads ${totals.leads}, cost/lead ${totals.costPerLead ?? "n/a"}, impressions ${totals.impressions}, clicks ${totals.clicks}`,
    "",
    "Per campaign:",
  ];
  for (const c of campaigns) {
    const m = c.metrics || {};
    lines.push(
      `- "${c.campaignName}${c.adSetName ? " / " + c.adSetName : ""}": spend ₹${m.spend}, impressions ${m.impressions}, reach ${m.reach}, clicks ${m.clicks}, CPM ₹${m.cpm}, CPC ₹${m.cpc}, CTR ${m.ctr}%, frequency ${m.frequency}, leads ${c.leads}, cost/lead ${c.costPerLead ?? "n/a"}`
    );
  }

  const raw = await callGrok(systemPrompt, lines.join("\n"), 900);
  const cleaned = (raw || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { summary: cleaned, topPerformers: [], underperformers: [], suggestions: [] };
  }
}

module.exports = { getMetaInsightsReport };
