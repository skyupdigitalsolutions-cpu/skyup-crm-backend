// services/sourcePerformanceService.js
// ─────────────────────────────────────────────────────────────────────────────
// SOURCE PERFORMANCE (Google Ads / Website)
//
// Unlike Meta, neither Google Ads nor the Website contact form expose a live
// ad-insights API in this system — their leads arrive purely via webhook and
// are tagged in the CRM:
//   • Google Ads leads → source "Google Ads", campaign = GoogleAdsConfig.campaignName
//   • Website leads     → source "Website",    campaign = WebsiteConfig.sourceName
//
// So this report is built from the CRM lead data itself, grouped per campaign /
// per configured source, and (for Google Ads) joined with the OPTIONAL manual
// `cost` field on GoogleAdsConfig to derive cost-per-lead / cost-per-conversion.
// It mirrors the Meta report's shape (totals + per-campaign cards + AI panel)
// so the two new Report Page tabs look and behave like Meta Performance.
//
// No new env / credentials required.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const Lead     = require("../models/Leads");
const { callGrok } = require("../utils/leadActionSummary"); // NOTE: real export is callGrok

// ── AI retry wrapper (handles transient 429s) ────────────────────────────────
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
          : 1500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, waitMs));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

// Defensive AiAnalysisCache accessor — the model isn't declared in /models, it's
// used ad-hoc. Register a permissive schema once if it isn't compiled yet so the
// cache works instead of throwing MissingSchemaError.
function getAiCache(conn) {
  try {
    return conn.model("AiAnalysisCache");
  } catch {
    const schema = new mongoose.Schema(
      {
        kind:      { type: String },
        company:   { type: mongoose.Schema.Types.ObjectId },
        rangeKey:  { type: String },
        payload:   { type: mongoose.Schema.Types.Mixed },
        createdAt: { type: Date, default: Date.now },
      },
      { strict: false }
    );
    return conn.model("AiAnalysisCache", schema);
  }
}

const num = (v) => (v == null || v === "" ? 0 : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;

function dateRange(from, to) {
  const toD   = to   ? new Date(to)   : new Date();
  const fromD = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  return { fromD, toD };
}

// Which lead statuses count as "converted". Same rule the Meta report uses.
const CONVERTED_RE = /^(converted|won|customer|closed won|closed-won|complete[d]?)$/i;
const isConverted = (status) => CONVERTED_RE.test(String(status || "").trim());

// ── Per-campaign issue detector ───────────────────────────────────────────────
function detectIssues({ active, leads, converted, cost, hasCost, isWebsite }) {
  const issues = [];

  if (!active) {
    issues.push({ level: "info", msg: "This source is paused — it is not currently capturing new leads." });
  }
  if (leads === 0) {
    issues.push({
      level: active ? "warn" : "info",
      msg: active
        ? "No leads captured in this period — check the webhook / form mapping is live."
        : "No leads captured in this period.",
    });
    return issues;
  }

  const convRate = leads > 0 ? (converted / leads) * 100 : 0;

  if (converted === 0) {
    issues.push({ level: "warn", msg: `${leads} lead${leads === 1 ? "" : "s"} captured but none converted yet — review follow-up quality.` });
  } else if (convRate < 10) {
    issues.push({ level: "warn", msg: `Low conversion rate (${round2(convRate)}%) — leads may be low intent or follow-up is slow.` });
  }

  if (!isWebsite) {
    if (hasCost && cost > 0 && converted === 0) {
      issues.push({ level: "error", msg: "Spend recorded but zero conversions — this campaign is currently not paying back." });
    }
    if (hasCost && cost > 0 && leads > 0) {
      const cpl = cost / leads;
      if (cpl > 0) issues.push({ level: "info", msg: `Cost per lead is ₹${round2(cpl)} for this period.` });
    }
    if (!hasCost || cost === 0) {
      issues.push({ level: "info", msg: "No spend entered for this campaign — add a cost to see cost-per-lead metrics." });
    }
  }

  if (issues.length === 0) issues.push({ level: "ok", msg: "Healthy — leads are flowing and converting." });
  return issues;
}

// ── Public: build the report ──────────────────────────────────────────────────
// opts:
//   company     ObjectId
//   from, to    ISO date strings | null
//   source      "Google Ads" | "Website"   (matches Lead.source)
//   configModel "GoogleAdsConfig" | "WebsiteConfig"
//   nameField   "campaignName" | "sourceName"   (config → campaign label)
//   withCost    boolean (Google Ads = true, Website = false)
//   cacheKind   string for the AI cache namespace
//   withAI      boolean
async function getSourcePerformanceReport({
  company, from, to, source, configModel, nameField, withCost = false, cacheKind, withAI = true,
}) {
  const { fromD, toD } = dateRange(from, to);
  const conn = Lead.db;

  // 1. Pull all matching leads in range (exclude merged duplicates and closed/wrong entries).
  const leads = await Lead.find({
    company,
    source,
    mergedInto: null,
    isClosed: { $ne: true },
    createdAt: { $gte: fromD, $lte: toD },
  }).select("campaign status").lean();

  // 2. Aggregate by campaign label.
  const byCampaign = new Map(); // label -> { leads, converted, statusBreakdown }
  const bump = (label) => {
    const key = label && String(label).trim() ? String(label).trim() : "(untagged)";
    if (!byCampaign.has(key)) byCampaign.set(key, { leads: 0, converted: 0, statusBreakdown: {} });
    return byCampaign.get(key);
  };
  for (const l of leads) {
    const row = bump(l.campaign);
    row.leads += 1;
    if (isConverted(l.status)) row.converted += 1;
    const st = String(l.status || "Unknown").trim() || "Unknown";
    row.statusBreakdown[st] = (row.statusBreakdown[st] || 0) + 1;
  }

  // 3. Load the configured sources so we can surface config-only info
  //    (cost, active/paused state) and show configs that had zero leads.
  let configs = [];
  try {
    const ConfigModel = conn.model(configModel);
    configs = await ConfigModel.find({ company }).lean();
  } catch {
    configs = [];
  }
  const configByName = new Map();
  for (const c of configs) {
    const label = String(c[nameField] || "").trim();
    if (label) configByName.set(label, c);
    // Ensure a card exists even with zero leads in the period.
    if (label && !byCampaign.has(label)) {
      byCampaign.set(label, { leads: 0, converted: 0, statusBreakdown: {} });
    }
  }

  // 4. Build per-campaign cards + totals.
  const totals = { leads: 0, converted: 0, cost: 0, impressions: 0, clicks: 0, campaigns: 0 };
  const campaigns = [];

  for (const [label, agg] of byCampaign.entries()) {
    const cfg     = configByName.get(label) || null;
    const active  = cfg ? cfg.isActive !== false : true;
    const hasCost = withCost && cfg && num(cfg.cost) > 0;
    const cost    = hasCost ? num(cfg.cost) : 0;

    // Ad metrics (manually entered on the config) — Google Ads only.
    const impressions = withCost && cfg ? num(cfg.impressions) : 0;
    const clicks      = withCost && cfg ? num(cfg.clicks)      : 0;
    const cpc = withCost && clicks > 0 && cost > 0        ? round2(cost / clicks)                : null; // ₹ per click
    const ctr = withCost && impressions > 0 && clicks > 0 ? round2((clicks / impressions) * 100) : null; // %
    const cpm = withCost && impressions > 0 && cost > 0   ? round2((cost / impressions) * 1000)  : null; // ₹ per 1000 impressions

    const convRate          = agg.leads > 0 ? round2((agg.converted / agg.leads) * 100) : null;
    const costPerLead       = hasCost && agg.leads > 0     ? round2(cost / agg.leads)     : null;
    const costPerConversion = hasCost && agg.converted > 0 ? round2(cost / agg.converted) : null;

    const issues = detectIssues({
      active,
      leads: agg.leads,
      converted: agg.converted,
      cost,
      hasCost,
      isWebsite: !withCost,
    });

    totals.leads       += agg.leads;
    totals.converted   += agg.converted;
    totals.cost        += cost;
    totals.impressions += impressions;
    totals.clicks      += clicks;
    totals.campaigns   += 1;

    campaigns.push({
      configId:          cfg ? String(cfg._id) : label,
      campaignName:      label,
      configured:        !!cfg,
      active,
      cost:              withCost ? cost : null,
      hasCost,
      impressions:       withCost ? impressions : null,
      clicks:            withCost ? clicks : null,
      cpc,
      ctr,
      cpm,
      leads:             agg.leads,
      converted:         agg.converted,
      conversionRatePct: convRate,
      costPerLead,
      costPerConversion,
      statusBreakdown:   agg.statusBreakdown,
      issues,
    });
  }

  // Sort: most leads first, then by name.
  campaigns.sort((a, b) => (b.leads - a.leads) || a.campaignName.localeCompare(b.campaignName));

  const overallConvRate = totals.leads > 0 ? round2((totals.converted / totals.leads) * 100) : null;
  const overallCPL      = withCost && totals.cost > 0 && totals.leads > 0     ? round2(totals.cost / totals.leads)     : null;
  const overallCPConv   = withCost && totals.cost > 0 && totals.converted > 0 ? round2(totals.cost / totals.converted) : null;
  const overallCPC      = withCost && totals.clicks > 0 && totals.cost > 0        ? round2(totals.cost / totals.clicks)                 : null;
  const overallCTR      = withCost && totals.impressions > 0 && totals.clicks > 0 ? round2((totals.clicks / totals.impressions) * 100)  : null;
  const overallCPM      = withCost && totals.impressions > 0 && totals.cost > 0   ? round2((totals.cost / totals.impressions) * 1000)   : null;

  const result = {
    range: { from: fromD, to: toD },
    source,
    withCost,
    totals: {
      leads:             totals.leads,
      converted:         totals.converted,
      conversionRatePct: overallConvRate,
      campaigns:         totals.campaigns,
      cost:              withCost ? round2(totals.cost) : null,
      impressions:       withCost ? totals.impressions : null,
      clicks:            withCost ? totals.clicks : null,
      cpc:               overallCPC,
      ctr:               overallCTR,
      cpm:               overallCPM,
      costPerLead:       overallCPL,
      costPerConversion: overallCPConv,
    },
    campaigns,
    aiAnalysis: null,
  };

  // 5. AI analysis (only when there is something to analyse).
  if (withAI && campaigns.some((c) => c.leads > 0)) {
    const AiCache  = getAiCache(conn);
    const rangeKey = `${from || "all"}..${to || "all"}`;
    try {
      let ai = null;
      const cached = await AiCache.findOne({ kind: cacheKind, company, rangeKey }).lean();
      if (cached?.payload) {
        ai = cached.payload;
        result.aiFromCache = true;
      } else {
        ai = await runSourceAIAnalysis({ source, withCost, campaigns, totals: result.totals });
        await AiCache.findOneAndUpdate(
          { kind: cacheKind, company, rangeKey },
          { kind: cacheKind, company, rangeKey, payload: ai, createdAt: new Date() },
          { upsert: true },
        );
      }
      result.aiAnalysis = ai;
      if (Array.isArray(ai.perCampaign)) {
        ai.perCampaign.forEach((p) => {
          const idx = Number(p.i);
          if (Number.isInteger(idx) && campaigns[idx]) {
            campaigns[idx].aiSuggestion = p.suggestion || "";
            campaigns[idx].aiVerdict    = p.verdict || "";
          }
        });
      }
    } catch (e) {
      result.aiAnalysisError = e?.code === "GROQ_PAYLOAD_TOO_LARGE"
        ? "Too much data to analyse at once — narrow the date range."
        : (e?.response?.status === 429
            ? "AI is busy right now (rate limited). Please try again in a moment."
            : (e?.message || "AI analysis unavailable right now."));
    }
  }

  return result;
}

// ── AI review builder ─────────────────────────────────────────────────────────
async function runSourceAIAnalysis({ source, withCost, campaigns, totals }) {
  const costLine = withCost
    ? "You are also given, where entered, the ad spend (cost), impressions, clicks, CPC, CTR and the cost per lead / cost per conversion. Use CPC/CTR to judge ad efficiency (high CPC or low CTR = the ad creative/targeting needs work) and cost-per-lead to judge value. Some campaigns may have no spend/metrics entered — do not invent figures for those."
    : "This is a WEBSITE / organic contact-form source, so there is NO ad spend — judge purely on lead volume and conversion quality, and never mention cost or budget.";

  const systemPrompt =
    `You are a lead-generation performance analyst reviewing the "${source}" channel of a CRM. ` +
    "You are given, per campaign/source, the leads captured, how many converted, and the conversion rate, " +
    "each prefixed with an index [i]. " + costLine + " " +
    "Analyse performance and respond in STRICT JSON only (no markdown), shape:\n" +
    "{\n" +
    '  "summary": "2-3 sentence overview of this channel\'s performance",\n' +
    '  "topPerformers": [{"campaign":"...","why":"what is working"}],\n' +
    '  "underperformers": [{"campaign":"...","issue":"what is wrong"}],\n' +
    '  "suggestions": ["overall actionable improvements"],\n' +
    '  "perCampaign": [{"i":0,"verdict":"Scale|Optimize|Pause|Watch","suggestion":"ONE specific next action for THIS campaign"}]\n' +
    "}\n" +
    "perCampaign MUST contain one entry for EVERY index given, with the matching i. " +
    "verdict: 'Scale' (working, do more), 'Optimize' (fixable issue), 'Pause' (not worth it), " +
    "'Watch' (too early / low data). Flag campaigns with leads but no conversions, and very low " +
    "conversion rates. Keep each suggestion under 110 characters.";

  const lines = [];
  if (withCost) {
    lines.push(`Overall: leads ${totals.leads}, converted ${totals.converted}, conv rate ${totals.conversionRatePct ?? "n/a"}%, spend ₹${totals.cost ?? 0}, impressions ${totals.impressions ?? 0}, clicks ${totals.clicks ?? 0}, CPC ${totals.cpc ?? "n/a"}, CTR ${totals.ctr ?? "n/a"}%, cost/lead ${totals.costPerLead ?? "n/a"}`);
  } else {
    lines.push(`Overall: leads ${totals.leads}, converted ${totals.converted}, conv rate ${totals.conversionRatePct ?? "n/a"}%`);
  }
  lines.push("", "Per campaign (index in brackets):");
  campaigns.forEach((c, i) => {
    const base = `[${i}] "${c.campaignName}"${c.active ? "" : " (paused)"}: leads ${c.leads}, converted ${c.converted}, conv rate ${c.conversionRatePct ?? "n/a"}%`;
    lines.push(withCost
      ? `${base}, spend ${c.hasCost ? "₹" + c.cost : "not set"}, impressions ${c.impressions ?? 0}, clicks ${c.clicks ?? 0}, CPC ${c.cpc ?? "n/a"}, CTR ${c.ctr ?? "n/a"}%, cost/lead ${c.costPerLead ?? "n/a"}`
      : base);
  });

  const raw = await callGrokWithRetry(systemPrompt, lines.join("\n"), 1300);
  const cleaned = (raw || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { summary: cleaned, topPerformers: [], underperformers: [], suggestions: [], perCampaign: [] };
  }
}

// Thin wrappers so controllers read cleanly.
function getGoogleAdsPerformanceReport({ company, from, to, withAI = true }) {
  return getSourcePerformanceReport({
    company, from, to,
    source:      "Google Ads",
    configModel: "GoogleAdsConfig",
    nameField:   "campaignName",
    withCost:    true,
    cacheKind:   "google_ads_performance",
    withAI,
  });
}

function getWebsitePerformanceReport({ company, from, to, withAI = true }) {
  return getSourcePerformanceReport({
    company, from, to,
    source:      "Website",
    configModel: "WebsiteConfig",
    nameField:   "sourceName",
    withCost:    false,
    cacheKind:   "website_performance",
    withAI,
  });
}

module.exports = {
  getSourcePerformanceReport,
  getGoogleAdsPerformanceReport,
  getWebsitePerformanceReport,
};