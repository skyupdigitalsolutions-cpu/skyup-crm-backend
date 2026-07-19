// services/marketingDashboardService.js
// ─────────────────────────────────────────────────────────────────────────────
// Aggregates CRM leads data for the Performance Marketing Dashboard.
// Uses real Leads + Users collections. No mock data.
// Beautify-safe: no ?. or ?? operators.
// ─────────────────────────────────────────────────────────────────────────────

const Lead = require("../models/Leads");
const User = require("../models/Users");

function safeNum(v) { return v && !isNaN(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0; }

// Build Mongo filter from query params
function buildFilter(company, query) {
  const filter = { company: company, mergedInto: null };

  // Date range
  if (query.from || query.to) {
    filter.date = {};
    if (query.from) filter.date["$gte"] = new Date(query.from);
    if (query.to) {
      const to = new Date(query.to);
      to.setHours(23, 59, 59, 999);
      filter.date["$lte"] = to;
    }
  }

  // Campaign / source / status
  if (query.campaign) filter.campaign = query.campaign;
  if (query.source)   filter.source   = query.source;
  if (query.status)   filter.status   = query.status;
  if (query.language) filter.language = query.language;

  // Employee filter
  if (query.userId) filter["user._id"] = query.userId;

  return filter;
}

// ── Main dashboard aggregation ────────────────────────────────────────────────
async function getMarketingDashboard({ company, query }) {
  const filter = buildFilter(company, query);

  // ── 1. Status counts ───────────────────────────────────────────────────────
  const statusAgg = await Lead.aggregate([
    { "$match": filter },
    { "$group": {
      "_id": "$status",
      "count": { "$sum": 1 },
    }},
  ]);
  const counts = {};
  for (let i = 0; i < statusAgg.length; i++) {
    counts[statusAgg[i]["_id"] || "Unknown"] = statusAgg[i].count;
  }
  const total      = Object.values(counts).reduce(function (s, v) { return s + v; }, 0);
  const converted  = counts["Converted"]     || 0;
  const inProgress = counts["In Progress"]   || 0;
  const notInt     = counts["Not Interested"] || 0;
  const newLeads   = counts["New"]           || 0;
  const verif      = counts["Verification"]  || 0;

  // ── 2. Previous period for trend arrows ───────────────────────────────────
  let prevTotal = 0, prevConverted = 0;
  if (query.from && query.to) {
    const fromD = new Date(query.from);
    const toD   = new Date(query.to);
    const diff  = toD - fromD;
    const prevFilter = Object.assign({}, filter, {
      date: { "$gte": new Date(fromD - diff), "$lte": new Date(fromD) },
    });
    delete prevFilter.date["$gte"];
    prevFilter.date = { "$gte": new Date(fromD.getTime() - diff), "$lte": fromD };
    const prevAgg = await Lead.aggregate([
      { "$match": prevFilter },
      { "$group": { "_id": null, count: { "$sum": 1 }, conv: { "$sum": { "$cond": [{ "$eq": ["$status", "Converted"] }, 1, 0] } } } },
    ]);
    if (prevAgg.length) { prevTotal = prevAgg[0].count; prevConverted = prevAgg[0].conv; }
  }

  function trend(curr, prev) {
    if (!prev) return null;
    return Math.round(((curr - prev) / prev) * 100);
  }

  // ── 3. Daily trend (last 30 days if no filter) ────────────────────────────
  const dailyAgg = await Lead.aggregate([
    { "$match": filter },
    { "$group": {
      "_id": { "$dateToString": { "format": "%Y-%m-%d", "date": "$date" } },
      total:     { "$sum": 1 },
      converted: { "$sum": { "$cond": [{ "$eq": ["$status", "Converted"] }, 1, 0] } },
      inProgress: { "$sum": { "$cond": [{ "$eq": ["$status", "In Progress"] }, 1, 0] } },
      newL:       { "$sum": { "$cond": [{ "$eq": ["$status", "New"] }, 1, 0] } },
    }},
    { "$sort": { "_id": 1 } },
  ]);

  // ── 4. Campaign breakdown ─────────────────────────────────────────────────
  const campaignAgg = await Lead.aggregate([
    { "$match": filter },
    { "$group": {
      "_id": { campaign: "$campaign", source: "$source" },
      total:     { "$sum": 1 },
      converted: { "$sum": { "$cond": [{ "$eq": ["$status", "Converted"] }, 1, 0] } },
      inProgress: { "$sum": { "$cond": [{ "$eq": ["$status", "In Progress"] }, 1, 0] } },
      newL:       { "$sum": { "$cond": [{ "$eq": ["$status", "New"] }, 1, 0] } },
      notInt:     { "$sum": { "$cond": [{ "$eq": ["$status", "Not Interested"] }, 1, 0] } },
    }},
    { "$sort": { total: -1 } },
    { "$limit": 20 },
  ]);

  // ── 5. Source (platform) breakdown ───────────────────────────────────────
  const sourceAgg = await Lead.aggregate([
    { "$match": filter },
    { "$group": {
      "_id": "$source",
      count:     { "$sum": 1 },
      converted: { "$sum": { "$cond": [{ "$eq": ["$status", "Converted"] }, 1, 0] } },
    }},
    { "$sort": { count: -1 } },
  ]);

  // ── 6. Employee leaderboard ────────────────────────────────────────────────
  const empAgg = await Lead.aggregate([
    { "$match": filter },
    { "$group": {
      "_id": { userId: "$user._id", name: "$user.name" },
      total:     { "$sum": 1 },
      converted: { "$sum": { "$cond": [{ "$eq": ["$status", "Converted"] }, 1, 0] } },
      inProgress: { "$sum": { "$cond": [{ "$eq": ["$status", "In Progress"] }, 1, 0] } },
      notInt:    { "$sum": { "$cond": [{ "$eq": ["$status", "Not Interested"] }, 1, 0] } },
    }},
    { "$sort": { converted: -1 } },
    { "$limit": 20 },
  ]);

  // ── 7. Follow-ups (today / upcoming / missed) ─────────────────────────────
  const now       = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd   = new Date(todayStart.getTime() + 86400000 - 1);
  const baseFollow = { company: company, mergedInto: null, followUpDate: { "$ne": null } };
  if (query.userId) baseFollow["user._id"] = query.userId;

  const todayFollowups    = await Lead.countDocuments(Object.assign({}, baseFollow, { followUpDate: { "$gte": todayStart, "$lte": todayEnd } }));
  const upcomingFollowups = await Lead.countDocuments(Object.assign({}, baseFollow, { followUpDate: { "$gt": todayEnd } }));
  const missedFollowups   = await Lead.countDocuments(Object.assign({}, baseFollow, { followUpDate: { "$lt": todayStart }, status: { "$nin": ["Converted", "Not Interested"] } }));

  // ── 8. Distinct campaigns + sources for filter dropdowns ─────────────────
  const distinctCampaigns = await Lead.distinct("campaign", { company: company, campaign: { "$nin": [null, ""] } });
  const distinctSources   = await Lead.distinct("source",   { company: company });

  // ── 9. Ad-level data (join with GoogleAdsConfig where available) ──────────
  let adPerformance = [];
  try {
    const GoogleAdsConfig = require("../models/GoogleAdsConfig");
    const gAds = await GoogleAdsConfig.find({ company: company, isActive: true }).lean();
    for (let i = 0; i < gAds.length; i++) {
      const g = gAds[i];
      const leadCount = await Lead.countDocuments({ company: company, campaign: g.campaignName, mergedInto: null });
      const convCount = await Lead.countDocuments({ company: company, campaign: g.campaignName, status: "Converted", mergedInto: null });
      adPerformance.push({
        name:        g.campaignName,
        source:      "Google Ads",
        impressions: safeNum(g.impressions),
        clicks:      safeNum(g.clicks),
        cost:        safeNum(g.cost),
        leads:       leadCount,
        converted:   convCount,
        ctr:         safeNum(g.clicks) && safeNum(g.impressions) ? Math.round((safeNum(g.clicks) / safeNum(g.impressions)) * 10000) / 100 : 0,
        cpl:         leadCount > 0 ? Math.round((safeNum(g.cost) / leadCount) * 100) / 100 : 0,
      });
    }
  } catch (e) { /* GoogleAdsConfig may not exist */ }

  // ── 10. Funnel computation ────────────────────────────────────────────────
  const funnelLeads     = total;
  const funnelConv      = converted;
  const funnelInProg    = inProgress;
  const funnelVerif     = verif;
  const funnelNotInt    = notInt;
  const funnelNew       = newLeads;

  return {
    range: {
      from: query.from || null,
      to:   query.to   || null,
    },
    kpis: {
      totalLeads:     total,
      newLeads:       funnelNew,
      inProgress:     funnelInProg,
      converted:      funnelConv,
      notInterested:  funnelNotInt,
      verification:   funnelVerif,
      conversionRate: total > 0 ? Math.round((funnelConv / total) * 10000) / 100 : 0,
      trends: {
        totalLeads: trend(total, prevTotal),
        converted:  trend(funnelConv, prevConverted),
      },
    },
    funnel: [
      { stage: "Total Leads",   count: funnelNew + funnelInProg + funnelConv + funnelNotInt + funnelVerif, color: "#6366F1" },
      { stage: "New",           count: funnelNew,    color: "#3B82F6" },
      { stage: "In Progress",   count: funnelInProg, color: "#F59E0B" },
      { stage: "Verification",  count: funnelVerif,  color: "#8B5CF6" },
      { stage: "Converted",     count: funnelConv,   color: "#10B981" },
      { stage: "Not Interested",count: funnelNotInt, color: "#EF4444" },
    ],
    followups: {
      today:    todayFollowups,
      upcoming: upcomingFollowups,
      missed:   missedFollowups,
    },
    daily: dailyAgg.map(function (d) {
      return { date: d["_id"], total: d.total, converted: d.converted, inProgress: d.inProgress, newLeads: d.newL };
    }),
    campaigns: campaignAgg.map(function (d) {
      return {
        campaign:   d["_id"].campaign || "—",
        source:     d["_id"].source   || "—",
        total:      d.total,
        converted:  d.converted,
        inProgress: d.inProgress,
        newLeads:   d.newL,
        notInt:     d.notInt,
        convRate:   d.total > 0 ? Math.round((d.converted / d.total) * 10000) / 100 : 0,
      };
    }),
    sources: sourceAgg.map(function (d) {
      return {
        source:    d["_id"] || "Unknown",
        count:     d.count,
        converted: d.converted,
        convRate:  d.count > 0 ? Math.round((d.converted / d.count) * 10000) / 100 : 0,
      };
    }),
    employees: empAgg.map(function (d) {
      const tot = d.total;
      return {
        name:       (d["_id"] && d["_id"].name) ? d["_id"].name : "Unassigned",
        userId:     (d["_id"] && d["_id"].userId) ? String(d["_id"].userId) : null,
        total:      tot,
        converted:  d.converted,
        inProgress: d.inProgress,
        notInt:     d.notInt,
        convRate:   tot > 0 ? Math.round((d.converted / tot) * 10000) / 100 : 0,
      };
    }),
    adPerformance: adPerformance,
    filters: {
      campaigns: distinctCampaigns.filter(Boolean).sort(),
      sources:   distinctSources.filter(Boolean).sort(),
    },
  };
}

module.exports = { getMarketingDashboard };
