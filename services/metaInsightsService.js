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

const axios      = require("axios");
const mongoose   = require("mongoose");
const MetaConfig = require("../models/MetaConfig");
const Lead       = require("../models/Leads");
const { callGrok } = require("../utils/leadActionSummary");

// Defensive AiAnalysisCache accessor — registers the schema on-demand the first
// time it is needed, so it never throws "Schema hasn't been registered for model".
function getAiCache(conn) {
  try {
    return conn.model("AiAnalysisCache");
  } catch (e) {
    const schema = new mongoose.Schema(
      {
        kind:     String,
        company:  mongoose.Schema.Types.ObjectId,
        rangeKey: String,
        payload:  mongoose.Schema.Types.Mixed,
        createdAt: { type: Date, default: Date.now },
      },
      { strict: false }
    );
    return conn.model("AiAnalysisCache", schema);
  }
}

// Call the AI with automatic retry on transient rate limits (HTTP 429).
// callGroq rethrows the underlying axios error, so we catch a 429 here, wait
// (honoring Retry-After when the provider sends it) and retry with exponential
// backoff before giving up. Prevents the raw "Request failed with status code
// 429" from reaching the AI Analysis panel.
async function callGroqWithRetry(systemPrompt, userContent, maxTokens, maxRetries = 2) {
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
  const toRaw   = to   ? new Date(to)   : new Date();
  const fromRaw = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  // BUG FIX (lead window): Meta's Insights `time_range.until` is an INCLUSIVE
  // full day, but the CRM lead filter used `createdAt <= midnight-of-to-date`,
  // which silently dropped every lead created on the final day (and, in IST,
  // shifted the whole window ~5.5h). That made leads/cost-per-lead look wrong
  // or empty. Expand fromD to the START of its day and toD to the END of its
  // day so the spend window and the lead window cover the same span.
  const fromD = new Date(fromRaw); fromD.setUTCHours(0, 0, 0, 0);
  const toD   = new Date(toRaw);   toD.setUTCHours(23, 59, 59, 999);
  return { since: fmt(fromRaw), until: fmt(toRaw), fromD, toD };
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

// ── Attribution queries: match CRM leads to a MetaConfig ──────────────────────
// BUG FIX (leads/cost blank): leads are SAVED with `metaConfigId = config._id`
// (canonical, per-ad-set — see utils/metaHelper.mapToLeadSchema) and
// `campaign = config.campaignName`. The report previously matched leads with
//     q.campaign = cfg.parentCampaignName || cfg.campaignName
// which is wrong on two counts:
//   1. It PREFERS parentCampaignName, but leads never store that — they store
//      campaignName (often the composite "Parent › AdSet" for synced configs).
//   2. It ignores metaConfigId entirely.
// So synced / ad-set configs matched nothing → 0 leads, null cost-per-lead,
// 0 converted, null conversion rate. Meanwhile the Campaigns page (getAllConfigs)
// counts by metaConfigId and looked correct — hence "works there, blank here".
//
// This mirrors getAllConfigs exactly:
//   PRIMARY — leads whose metaConfigId === cfg._id (reliable, per-ad-set).
//   LEGACY  — pre-metaConfigId leads (metaConfigId: null) matched by campaign
//             name / composite / adSetName, so old leads aren't lost and are
//             never double-counted with the primary set.
function buildLeadQueries(cfg, fromD, toD) {
  const base = {
    company: cfg.company,
    mergedInto: null,
    createdAt: { $gte: fromD, $lte: toD },
  };
  const primary = { ...base, metaConfigId: cfg._id };

  const matchers = [];
  if (cfg.campaignName) matchers.push(cfg.campaignName);
  if (cfg.parentCampaignName && cfg.adSetName) {
    matchers.push(`${cfg.parentCampaignName} › ${cfg.adSetName}`);
  }
  if (cfg.adSetName) matchers.push(cfg.adSetName);
  // NOTE: intentionally NOT matching the bare parentCampaignName. Every ad set
  // under one campaign shares that value, so matching it would count a legacy
  // (metaConfigId-less) lead once PER sibling ad-set config = duplicate leads.
  // This mirrors getAllConfigs, which also omits the bare parent name.
  const uniq = [...new Set(matchers.filter(Boolean))];

  const legacy = uniq.length
    ? { ...base, metaConfigId: null, campaign: uniq.length === 1 ? uniq[0] : { $in: uniq } }
    : null;

  return { primary, legacy };
}

// ── CRM lead count for this config's campaign/ad set in the period ────────────
async function leadCountForConfig(cfg, fromD, toD) {
  const { primary, legacy } = buildLeadQueries(cfg, fromD, toD);
  try {
    const [byId, byName] = await Promise.all([
      Lead.countDocuments(primary),
      legacy ? Lead.countDocuments(legacy) : Promise.resolve(0),
    ]);
    return byId + byName;
  } catch {
    return 0;
  }
}

// ── CRM CONVERTED count for this config in the period ─────────────────────────
// Same attribution as leadCountForConfig, but only leads now marked converted in
// the CRM. This is CRM outcome data shown against Meta spend — Meta itself
// doesn't know which leads converted.
const CONVERTED_RE = /^(converted|won|customer|closed won|closed-won|complete[d]?)$/i;
async function convertedCountForConfig(cfg, fromD, toD) {
  const { primary, legacy } = buildLeadQueries(cfg, fromD, toD);
  const countConverted = async (q) => {
    if (!q) return 0;
    const rows = await Lead.find(q).select("status").lean();
    return rows.filter(l => CONVERTED_RE.test(String(l.status || "").trim())).length;
  };
  try {
    const [byId, byName] = await Promise.all([
      countConverted(primary),
      countConverted(legacy),
    ]);
    return byId + byName;
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

  // BUG FIX (spend/leads vanish): do NOT filter isActive:true here. The auto-sync
  // sets isActive=false + pausedByMeta=true whenever an ad set is paused on Meta
  // (metaSyncService lines ~237/483). A PERFORMANCE REPORT covering a past range
  // must still include ad sets that are currently paused — otherwise all of their
  // historical spend AND leads silently disappear from the totals. Each card
  // already carries isActive / metaActive / pausedByMeta so the UI can show state.
  const configs = await Lead.db.model("MetaConfig").find({ company }).lean();

  const campaigns = [];
  const totals = { spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, converted: 0 };
  // Track adset IDs already counted in totals to prevent double-counting
  // when multiple configs share the same ad account (account-scope queries).
  const seenAdsetIds = new Set();

  // ── Deduplicate account-scope queries ────────────────────────────────────────
  // Multiple configs may share the same adAccountId (one per ad set/campaign).
  // For account-scope configs (no metaAdsetId/metaCampaignId), we must fetch
  // the ad account insights ONCE and cache the result, otherwise the same
  // adset spend is counted N times (once per config sharing that account).
  const accountInsightsCache = {};
  const getAccountInsights = async (cfg) => {
    if (cfg.metaAdsetId || cfg.metaCampaignId) {
      // Adset/campaign-scoped — fetch individually, no dedup needed
      return fetchInsightsForConfig(cfg, since, until);
    }
    const cacheKey = String(cfg.adAccountId) + "|" + String(cfg.adsToken);
    if (!accountInsightsCache[cacheKey]) {
      accountInsightsCache[cacheKey] = await fetchInsightsForConfig(cfg, since, until);
    }
    return accountInsightsCache[cacheKey];
  };

  for (const cfg of configs) {
    const insights = await getAccountInsights(cfg);
    const leadCount = await leadCountForConfig(cfg, fromD, toD);
    const convertedCount = await convertedCountForConfig(cfg, fromD, toD);

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
          category:     cfg.category || "",
          campaignName: cfg.parentCampaignName || cfg.campaignName,
          adSetName:    "",
          isActive:     cfg.isActive !== false,
          metaActive:   cfg.metaActive !== false,
          pausedByMeta: !!cfg.pausedByMeta,
          metaAdsetStatus: cfg.metaAdsetStatus || "",
          configured:   true,
          metrics:      { spend: 0, impressions: 0, reach: 0, clicks: 0, cpm: 0, cpc: 0, ctr: 0, frequency: 0 },
          leads:        leadCount,
          converted:    convertedCount,
          costPerLead:  null,
          costPerConversion: null,
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
          const adsetConverted = i === topSpendIdx ? convertedCount : 0;
          const costPerLead = adsetLeads > 0 ? Math.round((m.spend / adsetLeads) * 100) / 100 : null;
          const costPerConversion = adsetConverted > 0 ? Math.round((m.spend / adsetConverted) * 100) / 100 : null;

          // Per-ad-set health check (reuse detectIssues with a single-row shape).
          const issues = detectIssues({ configured: true, hasData: true, metrics: m }, adsetLeads);

          // Only add to totals if this adset hasn't been counted yet
          // (prevents double-counting when multiple configs share the same ad
          // account). Guard on a truthy adsetId so ad sets with a missing id
          // (rare) aren't wrongly collapsed into a single bucket.
          if (!a.adsetId || !seenAdsetIds.has(a.adsetId)) {
            if (a.adsetId) seenAdsetIds.add(a.adsetId);
            totals.spend       += m.spend;
            totals.impressions += m.impressions;
            totals.reach       += m.reach;
            totals.clicks      += m.clicks;
          }

          campaigns.push({
            configId:     cfg._id,
            category:     cfg.category || "",
            isActive:     cfg.isActive !== false,
            metaActive:   cfg.metaActive !== false,
            pausedByMeta: !!cfg.pausedByMeta,
            metaAdsetStatus: a.effectiveStatus || cfg.metaAdsetStatus || "",
            adsetId:      a.adsetId,
            campaignName: a.campaignName || cfg.parentCampaignName || cfg.campaignName,
            adSetName:    a.adsetName,
            configured:   true,
            metrics:      m,
            leads:        adsetLeads,
            converted:    adsetConverted,
            costPerLead,
            costPerConversion,
            issues,
          });
        });
      }
      totals.leads += leadCount;
      totals.converted += convertedCount;
      continue;
    }

    // ── Explicit single ad set scope, or not-configured ──────────────────────
    const issues = detectIssues(insights, leadCount);
    const m = insights.metrics || { spend: 0, impressions: 0, reach: 0, clicks: 0, cpm: 0, cpc: 0, ctr: 0, frequency: 0 };
    const costPerLead = leadCount > 0 ? Math.round((m.spend / leadCount) * 100) / 100 : null;
    const costPerConversion = convertedCount > 0 ? Math.round((m.spend / convertedCount) * 100) / 100 : null;

    // DEDUP FIX (mixed-scope double count): an explicit metaAdsetId config points
    // at ONE ad set. If that same ad set is ALSO covered by an account-scope
    // config (which breaks the account down per ad set above), its spend would be
    // added twice — once here, once there. Share the same seenAdsetIds set and
    // register this ad set so each ad set is counted at most once, no matter how
    // many configs reference it or in what order they're processed.
    const explicitAdsetId = cfg.metaAdsetId ? String(cfg.metaAdsetId) : "";
    const alreadyCounted   = explicitAdsetId && seenAdsetIds.has(explicitAdsetId);

    if (insights.configured && insights.hasData && !alreadyCounted) {
      if (explicitAdsetId) seenAdsetIds.add(explicitAdsetId);
      totals.spend       += m.spend;
      totals.impressions += m.impressions;
      totals.reach       += m.reach;
      totals.clicks      += m.clicks;
    }
    totals.leads += leadCount;
    totals.converted += convertedCount;

    campaigns.push({
      configId:     cfg._id,
      category:     cfg.category || "",
      isActive:     cfg.isActive !== false,
      metaActive:   cfg.metaActive !== false,
      pausedByMeta: !!cfg.pausedByMeta,
      metaAdsetStatus: cfg.metaAdsetStatus || "",
      // adsetId lets the dedupedCampaigns filter drop a duplicate card when the
      // same ad set is also emitted by an account-scope query.
      adsetId:      explicitAdsetId || undefined,
      campaignName: cfg.parentCampaignName || cfg.campaignName,
      adSetName:    cfg.adSetName || "",
      configured:   !!insights.configured,
      metrics:      m,
      leads:        leadCount,
      converted:    convertedCount,
      costPerLead,
      costPerConversion,
      issues,
    });
  }

  const overallCPL = totals.leads > 0 ? Math.round((totals.spend / totals.leads) * 100) / 100 : null;
  const overallCPConv = totals.converted > 0 ? Math.round((totals.spend / totals.converted) * 100) / 100 : null;
  const overallConvRate = totals.leads > 0 ? Math.round((totals.converted / totals.leads) * 10000) / 100 : null;

  // Deduplicate campaign cards — when multiple configs share the same ad account,
  // the same adsets appear multiple times. Keep only the first occurrence per adsetId.
  const seenCampaignAdsets = new Set();
  const dedupedCampaigns = campaigns.filter((c) => {
    if (!c.adsetId) return true; // not-configured cards — always keep
    if (seenCampaignAdsets.has(c.adsetId)) return false;
    seenCampaignAdsets.add(c.adsetId);
    return true;
  });

  const result = {
    range: { from: fromD, to: toD },
    totals: { ...totals, costPerLead: overallCPL, costPerConversion: overallCPConv, conversionRatePct: overallConvRate },
    campaigns: dedupedCampaigns,
    aiAnalysis: null,
  };

  // ── AI analysis + improvement suggestions ───────────────────────────────────
  // Only analyse campaigns that actually returned data; skip if none configured.
  const configured = campaigns.filter((c) => c.configured && c.metrics && (c.metrics.spend > 0 || c.metrics.impressions > 0));
  if (withAI && configured.length > 0) {
    const AiCache = getAiCache(Lead.db);
    const rangeKey = `${from || "all"}..${to || "all"}`;
    try {
      // 1. Reuse a fresh cached analysis if present (avoids a provider call → no 429).
      let ai = null;
      const cached = await AiCache.findOne({ kind: "meta_insights", company, rangeKey }).lean();
      if (cached?.payload) {
        ai = cached.payload;
        result.aiFromCache = true;
      } else {
        // 2. Otherwise call the AI and store the result for reuse.
        ai = await runMetaAIAnalysis(configured, result.totals);
        await AiCache.findOneAndUpdate(
          { kind: "meta_insights", company, rangeKey },
          { kind: "meta_insights", company, rangeKey, payload: ai, createdAt: new Date() },
          { upsert: true },
        );
      }
      result.aiAnalysis = ai;
      if (Array.isArray(ai.perAdset)) {
        ai.perAdset.forEach((p) => {
          const idx = Number(p.i);
          if (Number.isInteger(idx) && configured[idx]) {
            configured[idx].aiSuggestion = p.suggestion || "";
            configured[idx].aiVerdict    = p.verdict || "";
          }
        });
      }
    } catch (e) {
      result.aiAnalysisError = e.code === "GROQ_PAYLOAD_TOO_LARGE"
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

  const raw = await callGroqWithRetry(systemPrompt, lines.join("\n"), 1300);
  const cleaned = (raw || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { summary: cleaned, topPerformers: [], underperformers: [], suggestions: [], perAdset: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ad-level performance report
// Fetches insights at level=ad (one row per individual ad) and enriches each
// ad with its creative copy (text, headline, CTA, URL, thumbnail) from the
// /{ad_id}/adcreatives endpoint. Uses the same adsToken + adAccountId that
// the campaign-level insights use — no new permissions required.
// ─────────────────────────────────────────────────────────────────────────────
async function getMetaAdLevelReport({ company, from, to }) {
  // Include paused configs (see note in getMetaInsightsReport): a currently-paused
  // ad set may be the only config holding an account's adsToken; filtering it out
  // drops that whole ad account's spend from the ad-level report.
  const configs = await MetaConfig.find({ company: company }).lean();

  // Collect one entry per unique ad ACCOUNT.
  const acctMap = {};
  for (let i = 0; i < configs.length; i++) {
    const c = configs[i];
    const token = c.adsToken;
    const acct  = c.adAccountId;
    if (!token || !acct) continue;
    // BUG FIX (doubled spend): dedup by ACCOUNT only — NOT account+token. The
    // same ad account is usually referenced by several configs (one per ad set).
    // If two of them carry slightly different token strings, keying on
    // account+token queried that account twice and DOUBLED every ad's spend /
    // impressions / clicks in the totals (the donut still summed to the doubled
    // total, so it looked internally consistent but was 2× too high). One query
    // per account is correct — any valid token for that account works.
    const key = String(acct).trim();
    if (!acctMap[key]) acctMap[key] = { acct: acct, token: token, ver: c.graphApiVersion || "v22.0" };
  }

  const entries = Object.values(acctMap);
  if (entries.length === 0) {
    return { configured: false, ads: [], message: "No Meta ad accounts configured. Add adAccountId + adsToken to a campaign config." };
  }

  // Helper: safe number
  const n = function (v) { return v != null && !isNaN(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0; };

  // Date range
  const today    = new Date();
  const daysAgo  = function (d) { const dt = new Date(today); dt.setDate(dt.getDate() - d); return dt.toISOString().slice(0, 10); };
  const since    = from  || daysAgo(30);
  const until    = to    || daysAgo(0);
  const timeRange = JSON.stringify({ since: since, until: until });

  // Fetch creative details (text, headline, CTA, link, thumbnail)
  const fetchCreative = async function (adId, token, ver) {
    try {
      const fields = "body,title,object_story_spec,image_url,thumbnail_url,call_to_action_type,link_url,name";
      const r = await axios.get(
        "https://graph.facebook.com/" + ver + "/" + adId + "/adcreatives",
        { params: { fields: fields, access_token: token }, timeout: 10000 }
      );
      const cr = (r.data && r.data.data && r.data.data[0]) ? r.data.data[0] : null;
      if (!cr) return {};
      // Dig out text + headline from object_story_spec (link/video/photo stories)
      let body = cr.body || "";
      let headline = cr.title || "";
      let linkUrl  = cr.link_url || "";
      const spec = cr.object_story_spec;
      if (spec) {
        const ld = spec.link_data || spec.video_data || spec.photo_data || null;
        if (ld) {
          body     = body     || ld.message || "";
          headline = headline || ld.name    || ld.title || "";
          linkUrl  = linkUrl  || ld.link    || "";
        }
      }
      return {
        body:      body,
        headline:  headline,
        cta:       cr.call_to_action_type || "",
        linkUrl:   linkUrl,
        thumbnail: cr.thumbnail_url || cr.image_url || "",
      };
    } catch (e) {
      return {}; // creative fetch is best-effort
    }
  };

  const allAds = [];
  const errors = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    try {
      // Fetch insights at ad level — FOLLOW PAGINATION. limit=500 only returns
      // the FIRST page; accounts with more ads than that were silently truncated,
      // making totals too low. Meta returns a ready-to-use follow-up URL in
      // paging.next (it already carries the access_token + cursor), so we just
      // keep GETting it until there are no more pages (guarded at 20 pages).
      const rows = [];
      let nextUrl = "https://graph.facebook.com/" + e.ver + "/" + e.acct + "/insights";
      let nextParams = {
        level:        "ad",
        fields:       "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,clicks,cpm,cpc,ctr,frequency",
        time_range:   timeRange,
        limit:        500,
        access_token: e.token,
      };
      let pageGuard = 0;
      while (nextUrl && pageGuard < 20) {
        const insightsRes = await axios.get(nextUrl, { params: nextParams, timeout: 25000 });
        const pageRows = (insightsRes.data && Array.isArray(insightsRes.data.data)) ? insightsRes.data.data : [];
        for (let r = 0; r < pageRows.length; r++) rows.push(pageRows[r]);
        const paging = insightsRes.data && insightsRes.data.paging;
        nextUrl    = paging && paging.next ? paging.next : null;
        nextParams = undefined; // paging.next already contains all query params
        pageGuard++;
      }

      // Fetch ad status (active/paused) in a single batch call
      const adIds = rows.map(function (r) { return r.ad_id; }).filter(Boolean);
      const statusMap = {};
      if (adIds.length) {
        try {
          const idsParam = adIds.join(",");
          const batchRes = await axios.get(
            "https://graph.facebook.com/" + e.ver + "/",
            {
              params: {
                ids:          idsParam,
                fields:       "id,name,status,effective_status",
                access_token: e.token,
              },
              timeout: 15000,
            }
          );
          const batchData = batchRes.data || {};
          const keys = Object.keys(batchData);
          for (let k = 0; k < keys.length; k++) {
            const ad = batchData[keys[k]];
            if (ad && ad.id) statusMap[String(ad.id)] = ad.effective_status || ad.status || "";
          }
        } catch (batchErr) { /* status is best-effort */ }
      }

      // Enrich each ad with creative — run in parallel, limit concurrency
      const BATCH = 5;
      const enriched = [];
      for (let j = 0; j < rows.length; j += BATCH) {
        const chunk = rows.slice(j, j + BATCH);
        const results = await Promise.all(chunk.map(async function (row) {
          const creative = await fetchCreative(row.ad_id, e.token, e.ver);
          const adStatus = statusMap[String(row.ad_id)] || "";
          return {
            adId:         row.ad_id         || "",
            adName:       row.ad_name        || "(unnamed ad)",
            adsetId:      row.adset_id       || "",
            adsetName:    row.adset_name     || "",
            campaignId:   row.campaign_id    || "",
            campaignName: row.campaign_name  || "",
            status:       adStatus,
            metrics: {
              spend:       n(row.spend),
              impressions: n(row.impressions),
              reach:       n(row.reach),
              clicks:      n(row.clicks),
              cpm:         n(row.cpm),
              cpc:         n(row.cpc),
              ctr:         n(row.ctr),
              frequency:   n(row.frequency),
            },
            creative: creative,
          };
        }));
        for (let r = 0; r < results.length; r++) enriched.push(results[r]);
      }

      for (let j = 0; j < enriched.length; j++) allAds.push(enriched[j]);
    } catch (fetchErr) {
      const fbErr = fetchErr && fetchErr.response && fetchErr.response.data && fetchErr.response.data.error
        ? fetchErr.response.data.error.message : fetchErr.message;
      errors.push({ account: e.acct, error: fbErr });
    }
  }

  // Safety net: dedup by adId so a given ad is never counted twice in the
  // totals or listed twice (guards against any overlapping account references).
  const seenAdIds = new Set();
  const ads = allAds.filter(function (a) {
    if (!a.adId) return true;
    if (seenAdIds.has(a.adId)) return false;
    seenAdIds.add(a.adId);
    return true;
  });

  // Sort by spend desc
  ads.sort(function (a, b) { return b.metrics.spend - a.metrics.spend; });

  // Totals
  const totals = { spend: 0, impressions: 0, reach: 0, clicks: 0 };
  for (let i = 0; i < ads.length; i++) {
    const m = ads[i].metrics;
    totals.spend       += m.spend;
    totals.impressions += m.impressions;
    totals.reach       += m.reach;
    totals.clicks      += m.clicks;
  }
  totals.spend       = Math.round(totals.spend * 100) / 100;
  totals.impressions = Math.round(totals.impressions);
  totals.reach       = Math.round(totals.reach);
  totals.clicks      = Math.round(totals.clicks);

  // ── CRM leads for this period ─────────────────────────────────────────────
  // The ad-level view is per individual ad, but CRM leads attribute to an ad set
  // / campaign (never to a single Meta ad). So surface a company total plus a
  // per-campaign map (keyed by Meta campaign name) the UI can show against each
  // campaign group. Reuses the same full-day window + attribution (metaConfigId
  // primary, legacy name fallback) as the campaign-level report.
  const { fromD, toD } = dateRange(from, to);
  let totalLeads = 0;
  try {
    totalLeads = await Lead.countDocuments({
      company: company,
      mergedInto: null,
      source: { $regex: /meta/i },
      createdAt: { $gte: fromD, $lte: toD },
    });
  } catch (e) { totalLeads = 0; }

  const leadsByCampaign = {};
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    let lc = 0;
    try { lc = await leadCountForConfig(cfg, fromD, toD); } catch (e) { lc = 0; }
    if (!lc) continue;
    const key = String(cfg.parentCampaignName || cfg.campaignName || "").trim();
    if (key) leadsByCampaign[key] = (leadsByCampaign[key] || 0) + lc;
  }

  totals.leads       = totalLeads;
  totals.costPerLead = totalLeads > 0 ? Math.round((totals.spend / totalLeads) * 100) / 100 : null;

  return {
    configured: true,
    range: { from: since, to: until },
    totals: totals,
    leadsByCampaign: leadsByCampaign,
    ads: ads,
    errors: errors,
    accountsQueried: entries.length,
  };
}

module.exports = { getMetaInsightsReport, getMetaAdLevelReport };