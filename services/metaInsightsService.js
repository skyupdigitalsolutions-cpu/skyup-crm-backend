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

// Call the AI with automatic retry on transient rate limits (HTTP 429).
// callGrok rethrows the underlying axios error, so we catch a 429 here, wait
// (honoring Retry-After when the provider sends it) and retry with exponential
// backoff before giving up. Prevents the raw "Request failed with status code
// 429" from reaching the AI Analysis panel.
async function callGrokWithRetry(systemPrompt, userContent, maxTokens, maxRetries = 2) {
  let attempt = 0;
  for (;;) {
    try {
      return await callGrok(systemPrompt, userContent, maxTokens);
    } catch (e) {
      const status = e?.response?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfter = Number(e?.response?.headers?.["retry-after"]);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1500 * Math.pow(2, attempt); // 1.5s, then 3s
        await new Promise((r) => setTimeout(r, waitMs));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

const DEFAULT_VER = process.env.META_GRAPH_API_VERSION || "v21.0";

const num = (v) => (v == null || v === "" ? 0 : Number(v));

function dateRange(from, to) {
  const toD   = to   ? new Date(to)   : new Date();
  const fromD = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { since: fmt(fromD), until: fmt(toD), fromD, toD };
}

// ── Fetch insights for one config ─────────────────────────────────────────────
// Returns ONE of two shapes:
//   • Single scope (explicit metaAdsetId, or metaCampaignId):
//       { configured, hasData, level, metrics:{...} }
//   • Account scope (only adAccountId set):
//       { configured, hasData, level:"account", adsets:[ { adsetId, adsetName,
//         campaignName, metrics:{...} }, ... ] }
//
// THE BUG THIS FIXES:
//   Previously, account scope queried /{account}/insights with NO breakdown, so
//   Meta returned a SINGLE aggregated row = the whole-account total. That one
//   total was then shown identically on every ad set card. Now we pass
//   level=adset (+ adset_id/adset_name in fields), so Meta returns ONE ROW PER
//   AD SET with that ad set's real spend — and the caller expands them into
//   individual cards.
async function fetchInsightsForConfig(cfg, since, until) {
  const ver   = cfg.graphApiVersion || DEFAULT_VER;
  const token = cfg.adsToken;
  const acct  = cfg.adAccountId;

  if (!acct || !token) {
    return { configured: false };
  }

  // Scope: explicit ad set > explicit campaign > whole account (per-adset breakdown).
  let node, level;
  if (cfg.metaAdsetId)         { node = cfg.metaAdsetId;    level = "adset";    }
  else if (cfg.metaCampaignId) { node = cfg.metaCampaignId; level = "campaign"; }
  else                         { node = acct;               level = "account";  }

  const url = `https://graph.facebook.com/${ver}/${node}/insights`;

  // For account (and campaign) scope we break the response down BY ad set so
  // each ad set reports its own spend. For an explicit single ad set there is
  // nothing to break down.
  const breakdownByAdset = level === "account" || level === "campaign";

  const baseFields = "spend,impressions,reach,clicks,cpm,cpc,ctr,frequency";
  const params = {
    fields: breakdownByAdset
      ? `${baseFields},adset_id,adset_name,campaign_name`
      : baseFields,
    time_range: JSON.stringify({ since, until }),
    access_token: token,
  };
  if (breakdownByAdset) {
    // level=adset makes Meta return one row PER AD SET instead of one aggregate.
    params.level = "adset";
    params.limit = 500;
  }

  const emptyMetrics = () => ({ spend: 0, impressions: 0, reach: 0, clicks: 0, cpm: 0, cpc: 0, ctr: 0, frequency: 0 });
  const rowToMetrics = (row) => ({
    spend:       num(row.spend),
    impressions: num(row.impressions),
    reach:       num(row.reach),
    clicks:      num(row.clicks),
    cpm:         num(row.cpm),
    cpc:         num(row.cpc),
    ctr:         num(row.ctr),
    frequency:   num(row.frequency),
  });

  try {
    const { data } = await axios.get(url, { params, timeout: 20000 });
    const rows = (data && Array.isArray(data.data)) ? data.data : [];

    // ── Account / campaign scope: return per-ad-set rows ──────────────────────
    if (breakdownByAdset) {
      if (rows.length === 0) {
        return { configured: true, hasData: false, level, adsets: [] };
      }
      const adsets = rows.map((row) => ({
        adsetId:      row.adset_id || "",
        adsetName:    row.adset_name || "(unnamed ad set)",
        campaignName: row.campaign_name || "",
        metrics:      rowToMetrics(row),
      }));
      return { configured: true, hasData: true, level, adsets };
    }

    // ── Explicit single ad set scope: one metrics object ──────────────────────
    const row = rows[0] || null;
    if (!row) {
      return { configured: true, hasData: false, level, metrics: emptyMetrics() };
    }
    return { configured: true, hasData: true, level, metrics: rowToMetrics(row) };
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

    // ── Account/campaign scope: one card PER AD SET ───────────────────────────
    // fetchInsightsForConfig returns an `adsets` array for these. We emit a
    // separate card for each ad set so each shows its own real spend (this is
    // the fix for "every ad set showed the same total cost").
    if (insights.configured && Array.isArray(insights.adsets)) {
      if (insights.adsets.length === 0) {
        // Configured but no delivery in range — still surface the card + issues.
        const issues = detectIssues(insights, leadCount);
        campaigns.push({
          configId:     cfg._id,
          campaignName: cfg.parentCampaignName || cfg.campaignName,
          adSetName:    "",
          configured:   true,
          metrics:      { spend: 0, impressions: 0, reach: 0, clicks: 0, cpm: 0, cpc: 0, ctr: 0, frequency: 0 },
          leads:        leadCount,
          costPerLead:  null,
          issues,
        });
      } else {
        // NOTE on leads: CRM leads are tagged by campaign/ad-set NAME, not by
        // Meta adset_id, so we can only reliably attribute lead COUNT at the
        // config (campaign) level. To avoid showing the same lead count on every
        // ad set card, we attribute leads to the highest-spend ad set and leave
        // the rest null. (A precise split needs per-adset lead tagging.)
        const topSpendIdx = insights.adsets.reduce(
          (best, a, i, arr) => (a.metrics.spend > arr[best].metrics.spend ? i : best), 0,
        );
        insights.adsets.forEach((a, i) => {
          const m = a.metrics;
          const adsetLeads = i === topSpendIdx ? leadCount : 0;
          const costPerLead = adsetLeads > 0 ? Math.round((m.spend / adsetLeads) * 100) / 100 : null;

          // Per-ad-set health check (reuse detectIssues with a single-row shape).
          const issues = detectIssues({ configured: true, hasData: true, metrics: m }, adsetLeads);

          totals.spend       += m.spend;
          totals.impressions += m.impressions;
          totals.reach       += m.reach;
          totals.clicks      += m.clicks;

          campaigns.push({
            configId:     cfg._id,
            adsetId:      a.adsetId,
            campaignName: a.campaignName || cfg.parentCampaignName || cfg.campaignName,
            adSetName:    a.adsetName,
            configured:   true,
            metrics:      m,
            leads:        adsetLeads,
            costPerLead,
            issues,
          });
        });
      }
      totals.leads += leadCount;
      continue;
    }

    // ── Explicit single ad set / campaign scope, or not-configured ────────────
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
      const ai = await runMetaAIAnalysis(configured, result.totals);
      result.aiAnalysis = ai;
      // Attach each per-adset suggestion back onto its campaign card by index.
      if (Array.isArray(ai.perAdset)) {
        ai.perAdset.forEach((p) => {
          const idx = Number(p.i);
          if (Number.isInteger(idx) && configured[idx]) {
            configured[idx].aiSuggestion = p.suggestion || "";
            configured[idx].aiVerdict    = p.verdict || "";   // "Scale" | "Optimize" | "Pause" | "Watch"
          }
        });
      }
    } catch (e) {
      result.aiAnalysisError = e.code === "GROK_PAYLOAD_TOO_LARGE"
        ? "Too much data to analyse at once — narrow the date range."
        : (e?.response?.status === 429
            ? "AI is busy right now (rate limited). Please try again in a moment."
            : (e.message || "AI analysis unavailable right now."));
    }
  }

  return result;
}

// Build an AI performance review + improvement suggestions from the ad metrics.
async function runMetaAIAnalysis(campaigns, totals) {
  const systemPrompt =
    "You are a paid-media (Meta Ads) performance analyst. You are given ad metrics " +
    "per ad set (spend, impressions, reach, clicks, CPM, CPC, CTR, frequency), the " +
    "CRM leads captured, and the cost per lead, each prefixed with an index [i]. " +
    "Analyse performance and respond in STRICT JSON only (no markdown), shape:\n" +
    "{\n" +
    '  "summary": "2-3 sentence overview of overall ad performance & efficiency",\n' +
    '  "topPerformers": [{"campaign":"...","why":"what is working"}],\n' +
    '  "underperformers": [{"campaign":"...","issue":"what is wrong"}],\n' +
    '  "suggestions": ["overall actionable improvements"],\n' +
    '  "perAdset": [{"i":0,"verdict":"Scale|Optimize|Pause|Watch","suggestion":"ONE specific next action for THIS ad set"}]\n' +
    "}\n" +
    "perAdset MUST contain one entry for EVERY index given, with the matching i. " +
    "verdict: 'Scale' (working, spend more), 'Optimize' (fixable issue), 'Pause' " +
    "(wasting money), 'Watch' (too early/low data). Judge CTR (<0.5% weak, >1.5% " +
    "strong), cost per lead (flag the most expensive), frequency (>4 = fatigue), " +
    "and spend-with-no-leads. Keep each suggestion under 110 characters.";

  const lines = [
    `Overall: spend ₹${totals.spend}, leads ${totals.leads}, cost/lead ${totals.costPerLead ?? "n/a"}, impressions ${totals.impressions}, clicks ${totals.clicks}`,
    "",
    "Per ad set (index in brackets):",
  ];
  campaigns.forEach((c, i) => {
    const m = c.metrics || {};
    lines.push(
      `[${i}] "${c.campaignName}${c.adSetName ? " / " + c.adSetName : ""}": spend ₹${m.spend}, impressions ${m.impressions}, reach ${m.reach}, clicks ${m.clicks}, CPM ₹${m.cpm}, CPC ₹${m.cpc}, CTR ${m.ctr}%, frequency ${m.frequency}, leads ${c.leads}, cost/lead ${c.costPerLead ?? "n/a"}`
    );
  });

  const raw = await callGrokWithRetry(systemPrompt, lines.join("\n"), 1300);
  const cleaned = (raw || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { summary: cleaned, topPerformers: [], underperformers: [], suggestions: [], perAdset: [] };
  }
}

module.exports = { getMetaInsightsReport };
