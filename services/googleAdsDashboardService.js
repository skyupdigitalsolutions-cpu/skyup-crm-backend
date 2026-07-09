// services/googleAdsDashboardService.js
// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE ADS — BUSINESS PERFORMANCE DASHBOARD
//
// Builds a revenue-focused view of the Google Ads channel from REAL CRM data:
//   • Ad spend / impressions / clicks — entered per campaign on GoogleAdsConfig
//   • Revenue                        — (customers won) × campaign avgDealValue
//   • Leads / conversions / funnel   — derived from Leads (source "Google Ads")
//   • Sales-team performance         — from lead.user + scheduledCalls + meetings
//
// Sections that need a live Google Ads API or Google Analytics (device, location,
// keyword, landing-page analytics) are intentionally NOT produced here — the data
// isn't captured anywhere and must not be fabricated.
//
// No new env / credentials.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const Lead     = require("../models/Leads");
const { callGrok } = require("../utils/leadActionSummary");

const num    = (v) => (v == null || v === "" ? 0 : Number(v) || 0);
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const safeDiv = (a, b) => (b > 0 ? a / b : null);

// "Won customer" statuses. In this CRM the won status is "Converted".
const WON_RE = /^(converted|won|customer|closed[\s-]?won)$/i;
const isWon  = (s) => WON_RE.test(String(s || "").trim());
// "Qualified" proxy: progressed past New (no Google-side lead scoring exists).
const QUALIFIED_STATUSES = new Set(["in progress", "converted"]);
const isQualified = (s) => QUALIFIED_STATUSES.has(String(s || "").trim().toLowerCase());

function ranges(from, to) {
  const toD   = to   ? new Date(to)   : new Date();
  const fromD = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const span  = Math.max(1, toD.getTime() - fromD.getTime());
  const prevTo   = new Date(fromD.getTime());
  const prevFrom = new Date(fromD.getTime() - span);
  return { fromD, toD, prevFrom, prevTo };
}

function getAiCache(conn) {
  try { return conn.model("AiAnalysisCache"); }
  catch {
    const schema = new mongoose.Schema(
      { kind: String, company: mongoose.Schema.Types.ObjectId, rangeKey: String, payload: mongoose.Schema.Types.Mixed, createdAt: { type: Date, default: Date.now } },
      { strict: false }
    );
    return conn.model("AiAnalysisCache", schema);
  }
}

// Trend direction vs previous period. `better` = which way is good.
function trend(curr, prev, better = "up") {
  if (prev == null || curr == null) return { deltaPct: null, dir: "flat", color: "orange" };
  if (prev === 0 && curr === 0)     return { deltaPct: 0,    dir: "flat", color: "orange" };
  const deltaPct = prev === 0 ? 100 : round2(((curr - prev) / Math.abs(prev)) * 100);
  let dir = "flat";
  if (deltaPct > 2)  dir = "up";
  else if (deltaPct < -2) dir = "down";
  let color = "orange";
  if (better === "neutral") color = "orange";
  else if (dir === "flat")  color = "orange";
  else {
    const good = (better === "up" && dir === "up") || (better === "down" && dir === "down");
    color = good ? "green" : "red";
  }
  return { deltaPct, dir, color };
}

// ── Lead-derived aggregates for a date window ────────────────────────────────
async function aggregateLeads({ company, fromD, toD, campaign, salesperson, status }) {
  const q = {
    company,
    source: "Google Ads",
    mergedInto: null,
    createdAt: { $gte: fromD, $lte: toD },
  };
  if (campaign)    q.campaign = campaign;
  if (salesperson) q.user     = salesperson;
  if (status)      q.status   = status;

  const leads = await Lead.find(q)
    .select("campaign status user date createdAt scheduledCalls meetingRemarks")
    .lean();

  return leads;
}

// ── Public entry ─────────────────────────────────────────────────────────────
async function getGoogleAdsDashboard({ company, from, to, campaign, salesperson, status, withAI = false }) {
  const { fromD, toD, prevFrom, prevTo } = ranges(from, to);
  const conn = Lead.db;

  // Configs (spend / impressions / clicks / avgDealValue / active).
  let configs = [];
  try {
    const Cfg = conn.model("GoogleAdsConfig");
    const cq = { company };
    if (campaign) cq.campaignName = campaign;
    configs = await Cfg.find(cq).lean();
  } catch { configs = []; }
  const cfgByName = new Map(configs.map((c) => [String(c.campaignName || "").trim(), c]));

  // Users (salesperson names).
  let userMap = new Map();
  try {
    const User = conn.model("User");
    const users = await User.find({ company }).select("name email").lean();
    userMap = new Map(users.map((u) => [String(u._id), u.name || u.email || "Unknown"]));
  } catch { /* names optional */ }

  const leads     = await aggregateLeads({ company, fromD, toD, campaign, salesperson, status });
  const prevLeads = await aggregateLeads({ company, fromD: prevFrom, toD: prevTo, campaign, salesperson, status });

  // ── Per-campaign roll-up ────────────────────────────────────────────────────
  const camp = new Map(); // name -> { leads, won, qualified, statusBreakdown }
  const ensure = (name) => {
    const key = (name && String(name).trim()) || "(untagged)";
    if (!camp.has(key)) camp.set(key, { leads: 0, won: 0, qualified: 0 });
    return camp.get(key);
  };
  for (const l of leads) {
    const r = ensure(l.campaign);
    r.leads += 1;
    if (isWon(l.status)) r.won += 1;
    if (isQualified(l.status)) r.qualified += 1;
  }
  // Ensure configured campaigns show even with 0 leads.
  for (const c of configs) ensure(c.campaignName);

  const campaigns = [];
  const totals = { spend: 0, impressions: 0, clicks: 0, leads: 0, qualified: 0, won: 0, revenue: 0 };

  for (const [name, agg] of camp.entries()) {
    const cfg = cfgByName.get(name) || null;
    const spend       = cfg ? num(cfg.cost)         : 0;
    const impressions = cfg ? num(cfg.impressions)  : 0;
    const clicks      = cfg ? num(cfg.clicks)       : 0;
    const avgDeal     = cfg ? num(cfg.avgDealValue) : 0;
    const active      = cfg ? cfg.isActive !== false : true;

    const revenue        = agg.won * avgDeal;
    const ctr            = safeDiv(clicks, impressions);
    const avgCpc         = safeDiv(spend, clicks);
    const conversionRate = safeDiv(agg.won, agg.leads);
    const cpl            = safeDiv(spend, agg.leads);
    const cpa            = safeDiv(spend, agg.won);
    const roas           = safeDiv(revenue, spend);
    const roi            = spend > 0 ? ((revenue - spend) / spend) * 100 : null;

    totals.spend       += spend;
    totals.impressions += impressions;
    totals.clicks      += clicks;
    totals.leads       += agg.leads;
    totals.qualified   += agg.qualified;
    totals.won         += agg.won;
    totals.revenue     += revenue;

    campaigns.push({
      configId:           cfg ? String(cfg._id) : name,
      campaignName:       name,
      configured:         !!cfg,
      status:             active ? "Active" : "Paused",
      budget:             cfg && cfg.budget != null ? num(cfg.budget) : null, // budget not tracked separately → null
      spend, impressions, clicks,
      ctr:                ctr == null ? null : round2(ctr * 100),
      avgCpc:             avgCpc == null ? null : round2(avgCpc),
      conversions:        agg.won,
      conversionRatePct:  conversionRate == null ? null : round2(conversionRate * 100),
      costPerConversion:  cpa == null ? null : round2(cpa),
      leads:              agg.leads,
      qualified:          agg.qualified,
      avgDealValue:       avgDeal,
      revenue:            round2(revenue),
      cpl:                cpl == null ? null : round2(cpl),
      roas:               roas == null ? null : round2(roas),
      roi:                roi == null ? null : round2(roi),
      profit:             round2(revenue - spend),
    });
  }
  campaigns.sort((a, b) => (b.revenue - a.revenue) || (b.leads - a.leads));

  // ── Previous-period lead counts (for trend arrows). Spend is the entered
  //    total (not date-bound), so money metrics reuse the same spend both sides.
  const prevWon       = prevLeads.filter((l) => isWon(l.status)).length;
  const prevLeadCount = prevLeads.length;
  const prevQualified = prevLeads.filter((l) => isQualified(l.status)).length;
  const prevRevenue   = prevLeads.reduce((s, l) => {
    if (!isWon(l.status)) return s;
    const cfg = cfgByName.get(String(l.campaign || "").trim());
    return s + (cfg ? num(cfg.avgDealValue) : 0);
  }, 0);

  const spend = round2(totals.spend);
  const revenue = round2(totals.revenue);
  const overall = {
    spend,
    revenue,
    roas:            safeDiv(revenue, spend) == null ? null : round2(revenue / spend),
    roi:             spend > 0 ? round2(((revenue - spend) / spend) * 100) : null,
    clicks:          totals.clicks,
    leads:           totals.leads,
    qualified:       totals.qualified,
    won:             totals.won,
    cpl:             safeDiv(spend, totals.leads) == null ? null : round2(spend / totals.leads),
    cpa:             safeDiv(spend, totals.won)   == null ? null : round2(spend / totals.won),
    conversionRate:  safeDiv(totals.won, totals.leads) == null ? null : round2((totals.won / totals.leads) * 100),
    impressions:     totals.impressions,
  };

  // KPI cards with trend + traffic-light colour.
  const prevRoas = safeDiv(prevRevenue, spend);
  const prevRoi  = spend > 0 ? ((prevRevenue - spend) / spend) * 100 : null;
  const kpis = [
    { key: "spend",          label: "Total Ad Spend",  value: overall.spend,          format: "money",   trend: trend(null, null, "neutral") },
    { key: "revenue",        label: "Revenue",         value: overall.revenue,        format: "money",   trend: trend(revenue, prevRevenue, "up") },
    { key: "roas",           label: "ROAS",            value: overall.roas,           format: "x",       trend: trend(overall.roas, prevRoas == null ? null : round2(prevRoas), "up") },
    { key: "roi",            label: "ROI",             value: overall.roi,            format: "percent", trend: trend(overall.roi, prevRoi == null ? null : round2(prevRoi), "up") },
    { key: "clicks",         label: "Total Clicks",    value: overall.clicks,         format: "int",     trend: trend(null, null, "neutral") },
    { key: "leads",          label: "Total Leads",     value: overall.leads,          format: "int",     trend: trend(overall.leads, prevLeadCount, "up") },
    { key: "qualified",      label: "Qualified Leads", value: overall.qualified,      format: "int",     trend: trend(overall.qualified, prevQualified, "up") },
    { key: "won",            label: "Customers Won",   value: overall.won,            format: "int",     trend: trend(overall.won, prevWon, "up") },
    { key: "cpl",            label: "Cost / Lead",     value: overall.cpl,            format: "money",   trend: trend(overall.cpl, safeDiv(spend, prevLeadCount) == null ? null : round2(spend / prevLeadCount), "down") },
    { key: "cpa",            label: "Cost / Acq.",     value: overall.cpa,            format: "money",   trend: trend(overall.cpa, safeDiv(spend, prevWon) == null ? null : round2(spend / prevWon), "down") },
    { key: "conversionRate", label: "Conversion Rate", value: overall.conversionRate, format: "percent", trend: trend(overall.conversionRate, safeDiv(prevWon, prevLeadCount) == null ? null : round2((prevWon / prevLeadCount) * 100), "up") },
  ];

  // ── Funnel (real CRM stages only) ────────────────────────────────────────────
  const clicksTotal = totals.clicks;
  const contacted   = leads.filter((l) => String(l.status || "").trim().toLowerCase() !== "new").length;
  const followUp    = leads.filter((l) => Array.isArray(l.scheduledCalls) && l.scheduledCalls.length > 0).length;
  const meetings    = leads.filter((l) => Array.isArray(l.meetingRemarks) && l.meetingRemarks.length > 0).length;

  const rawStages = [
    clicksTotal > 0 ? { name: "Ad Clicks", count: clicksTotal, note: "entered" } : null,
    { name: "Leads Created", count: totals.leads },
    { name: "Contacted",     count: contacted },
    { name: "Follow-up Scheduled", count: followUp },
    { name: "Meeting Held",  count: meetings },
    { name: "Won Customers", count: totals.won },
  ].filter(Boolean);

  const topCount = rawStages.length ? rawStages[0].count : 0;
  const funnel = rawStages.map((s, i) => {
    const prev = i === 0 ? null : rawStages[i - 1].count;
    const fromPrevPct = prev == null ? null : (prev > 0 ? round2((s.count / prev) * 100) : 0);
    const dropOffPct  = fromPrevPct == null ? null : round2(100 - fromPrevPct);
    const conversionPct = topCount > 0 ? round2((s.count / topCount) * 100) : 0;
    return {
      name: s.name,
      count: s.count,
      fromPrevPct,
      dropOffPct,
      conversionPct,
      bigDropOff: dropOffPct != null && dropOffPct >= 70, // highlight red
    };
  });

  // ── CRM sales performance ────────────────────────────────────────────────────
  const statusCount = (re) => leads.filter((l) => re.test(String(l.status || "").trim())).length;
  const lostCount   = statusCount(/^(not interested|lost|closed|junk|invalid)$/i);
  const interested  = statusCount(/^(in progress|interested)$/i);
  const crmSales = {
    totalLeads:        totals.leads,
    qualifiedLeads:    totals.qualified,
    interestedLeads:   interested,
    lostLeads:         lostCount,
    wonCustomers:      totals.won,
    revenue,
    avgDealSize:       totals.won > 0 ? round2(revenue / totals.won) : 0,
    revenuePerLead:    totals.leads > 0 ? round2(revenue / totals.leads) : 0,
    revenuePerCustomer:totals.won > 0 ? round2(revenue / totals.won) : 0,
  };

  // ── Sales-team performance ────────────────────────────────────────────────────
  const byUser = new Map();
  const ensureUser = (uid) => {
    const key = uid ? String(uid) : "unassigned";
    if (!byUser.has(key)) byUser.set(key, { assigned: 0, calls: 0, meetings: 0, followUps: 0, won: 0, revenue: 0, respSum: 0, respN: 0 });
    return byUser.get(key);
  };
  for (const l of leads) {
    const r = ensureUser(l.user);
    r.assigned += 1;
    const calls = Array.isArray(l.scheduledCalls) ? l.scheduledCalls : [];
    const meets = Array.isArray(l.meetingRemarks) ? l.meetingRemarks : [];
    r.calls     += calls.length;
    r.followUps += calls.filter((c) => c.type === "follow-up").length;
    r.meetings  += meets.length;
    if (isWon(l.status)) {
      r.won += 1;
      const cfg = cfgByName.get(String(l.campaign || "").trim());
      r.revenue += cfg ? num(cfg.avgDealValue) : 0;
    }
    // Best-effort response time: lead.date → earliest completed activity.
    const created = l.date || l.createdAt;
    if (created) {
      const acts = [
        ...calls.filter((c) => c.doneAt).map((c) => new Date(c.doneAt).getTime()),
        ...meets.filter((m) => m.metAt).map((m) => new Date(m.metAt).getTime()),
      ].filter((t) => t && t >= new Date(created).getTime());
      if (acts.length) {
        r.respSum += (Math.min(...acts) - new Date(created).getTime());
        r.respN   += 1;
      }
    }
  }
  const salesTeam = [...byUser.entries()].map(([uid, r]) => ({
    userId:            uid === "unassigned" ? null : uid,
    salesperson:       uid === "unassigned" ? "Unassigned" : (userMap.get(uid) || "Unknown"),
    assignedLeads:     r.assigned,
    callsLogged:       r.calls,
    meetings:          r.meetings,
    followUps:         r.followUps,
    closedDeals:       r.won,
    revenue:           round2(r.revenue),
    conversionRatePct: r.assigned > 0 ? round2((r.won / r.assigned) * 100) : 0,
    avgResponseHours:  r.respN > 0 ? round2(r.respSum / r.respN / 3600000) : null,
  })).sort((a, b) => b.revenue - a.revenue || b.closedDeals - a.closedDeals);

  const result = {
    range: { from: fromD, to: toD },
    filtersApplied: { campaign: campaign || null, salesperson: salesperson || null, status: status || null },
    kpis,
    overall,
    campaigns,
    funnel,
    crmSales,
    salesTeam,
    notes: {
      qualified: "\"Qualified\" = leads progressed past New (In Progress / Converted). No Google-side lead scoring exists.",
      revenue:   "Revenue = customers won × the average deal value set per campaign.",
      unavailable: "Device, Location, Keyword and Landing-page analytics require a Google Ads API / Google Analytics integration and are not shown.",
    },
    aiAnalysis: null,
  };

  // ── AI business analysis ──────────────────────────────────────────────────────
  if (withAI && (totals.leads > 0 || totals.spend > 0)) {
    const AiCache  = getAiCache(conn);
    const rangeKey = `${from || "all"}..${to || "all"}|${campaign || ""}|${salesperson || ""}|${status || ""}`;
    try {
      let ai;
      const cached = await AiCache.findOne({ kind: "google_ads_dashboard", company, rangeKey }).lean();
      if (cached?.payload) { ai = cached.payload; result.aiFromCache = true; }
      else {
        ai = await runDashboardAI({ overall, campaigns, funnel, salesTeam, crmSales });
        await AiCache.findOneAndUpdate(
          { kind: "google_ads_dashboard", company, rangeKey },
          { kind: "google_ads_dashboard", company, rangeKey, payload: ai, createdAt: new Date() },
          { upsert: true },
        );
      }
      result.aiAnalysis = ai;
    } catch (e) {
      result.aiAnalysisError = e?.response?.status === 429
        ? "AI is busy right now (rate limited). Try again shortly."
        : (e?.message || "AI analysis unavailable right now.");
    }
  }

  return result;
}

// ── AI prompt ─────────────────────────────────────────────────────────────────
async function runDashboardAI({ overall, campaigns, funnel, salesTeam, crmSales }) {
  const systemPrompt =
    "You are a performance-marketing + sales analyst reviewing a company's Google Ads channel using their CRM data. " +
    "You are given overall KPIs, per-campaign metrics (spend, CTR, CPC, leads, conversions, CPL, CPA, ROAS, ROI, revenue), " +
    "a lead funnel with drop-off %, CRM sales figures, and sales-team performance. " +
    "Revenue = customers won × an average deal value entered per campaign; there is NO device / location / keyword / landing-page data, so never invent those. " +
    "Judge where ad money converts to customers, where leads drop off (advertising vs sales-follow-up), and which campaigns drive ROI. " +
    "Respond in STRICT JSON only (no markdown), shape:\n" +
    "{\n" +
    '  "summary": "3-4 sentence business overview",\n' +
    '  "problems": ["specific problems detected, each concrete and data-backed"],\n' +
    '  "recommendations": ["specific actions, most impactful first"],\n' +
    '  "expectedImpact": "what improving these would likely achieve",\n' +
    '  "priority": "High|Medium|Low"\n' +
    "}\n" +
    "Distinguish advertising problems (high CPL, low CTR) from sales problems (leads but no conversions, big drop-off after Contacted). Keep each item under 160 characters.";

  const L = [];
  L.push(`Overall: spend ₹${overall.spend}, revenue ₹${overall.revenue}, ROAS ${overall.roas ?? "n/a"}x, ROI ${overall.roi ?? "n/a"}%, clicks ${overall.clicks}, leads ${overall.leads}, qualified ${overall.qualified}, won ${overall.won}, CPL ${overall.cpl ?? "n/a"}, CPA ${overall.cpa ?? "n/a"}, conv rate ${overall.conversionRate ?? "n/a"}%`);
  L.push("", "Campaigns:");
  campaigns.forEach((c) => L.push(`- "${c.campaignName}" (${c.status}): spend ₹${c.spend}, CTR ${c.ctr ?? "n/a"}%, CPC ${c.avgCpc ?? "n/a"}, leads ${c.leads}, won ${c.conversions}, conv ${c.conversionRatePct ?? "n/a"}%, CPL ${c.cpl ?? "n/a"}, CPA ${c.costPerConversion ?? "n/a"}, revenue ₹${c.revenue}, ROAS ${c.roas ?? "n/a"}x, ROI ${c.roi ?? "n/a"}%`));
  L.push("", "Funnel (count, drop-off% from previous):");
  funnel.forEach((s) => L.push(`- ${s.name}: ${s.count}${s.dropOffPct != null ? ` (drop-off ${s.dropOffPct}%)` : ""}`));
  L.push("", `CRM sales: leads ${crmSales.totalLeads}, qualified ${crmSales.qualifiedLeads}, won ${crmSales.wonCustomers}, revenue ₹${crmSales.revenue}, avg deal ₹${crmSales.avgDealSize}, revenue/lead ₹${crmSales.revenuePerLead}`);
  L.push("", "Sales team:");
  salesTeam.forEach((s) => L.push(`- ${s.salesperson}: assigned ${s.assignedLeads}, meetings ${s.meetings}, follow-ups ${s.followUps}, closed ${s.closedDeals}, conv ${s.conversionRatePct}%, revenue ₹${s.revenue}`));

  let raw;
  let attempt = 0;
  for (;;) {
    try { raw = await callGrok(systemPrompt, L.join("\n"), 1400); break; }
    catch (e) {
      if (e?.response?.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt))); attempt++; continue;
      }
      throw e;
    }
  }
  const cleaned = (raw || "").replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); }
  catch { return { summary: cleaned, problems: [], recommendations: [], expectedImpact: "", priority: "Medium" }; }
}

module.exports = { getGoogleAdsDashboard };