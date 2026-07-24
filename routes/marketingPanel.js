// routes/marketingPanel.js
// Dedicated routes for the Performance Marketing Panel (separate login/panel).
// All routes protected by marketingAuthMiddleware (admin-only, no employees).

const express  = require("express");
const router   = express.Router();
const jwt      = require("jsonwebtoken");
const bcrypt   = require("bcryptjs");
const Admin    = require("../models/Admin");
const { protectMarketing } = require("../middlewares/marketingAuthMiddleware");
const { getMarketingDashboard } = require("../controllers/adminController");

// ── Dedicated marketing panel login ───────────────────────────────────────────
// Marketing users ONLY — accepts marketingAccess:true admins + super_admin.
// Returns same JWT shape as main login so mktApi interceptor works identically.
router.post("/login", async function (req, res) {
  try {
    const email    = (req.body.email    || "").toLowerCase().trim();
    const password = req.body.password  || "";
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const admin = await Admin.findOne({ email: email }).populate("company");
    if (!admin || !(await admin.matchPassword(password))) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    if (!admin.company || !admin.company.isActive) {
      return res.status(403).json({ message: "Company is suspended." });
    }

    const isSuperAdmin = admin.role === "super_admin" || admin.role === "superadmin";
    const isMarketingUser = admin.role === "marketing_user" || admin.marketingAccess;
    if (!isSuperAdmin && !isMarketingUser) {
      return res.status(403).json({ message: "Marketing panel access not granted. Contact your super admin." });
    }

    const token = require("../utils/generateToken")(admin._id, admin.role);
    return res.json({
      _id:         admin._id,
      name:        admin.name,
      email:       admin.email,
      role:        admin.role,
      companyId:   admin.company._id,
      companyName: admin.company.name,
      logoUrl:     admin.company.brandLogoUrl || "",
      marketingAccess: admin.marketingAccess || isSuperAdmin,
      token:       token,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Marketing panel auth check ────────────────────────────────────────────────
router.get("/me", protectMarketing, function (req, res) {
  const admin   = req.admin;
  const company = admin.company || {};
  res.json({
    _id:         admin._id,
    name:        admin.name,
    email:       admin.email,
    role:        admin.role,
    companyId:   company._id   || null,
    companyName: company.name  || "",
    logoUrl:     company.brandLogoUrl || "",
  });
});

// ── Dashboard data ─────────────────────────────────────────────────────────────
router.get("/dashboard", protectMarketing, getMarketingDashboard);

// ── Meta insights (campaign-level performance) ─────────────────────────────────
router.get("/meta-insights", protectMarketing, function (req, res, next) {
  try {
    const { getMetaInsightsReport } = require("../services/metaInsightsService");
    const companyId = req.admin.company._id || req.admin.company;
    getMetaInsightsReport({ company: companyId, from: req.query.from || null, to: req.query.to || null, withAI: false })
      .then(function (data) { res.json(data); })
      .catch(function (err) { res.status(500).json({ message: err.message }); });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Google Ads report ──────────────────────────────────────────────────────────
router.get("/google-ads", protectMarketing, function (req, res, next) {
  try {
    const GoogleAdsConfig = require("../models/GoogleAdsConfig");
    const companyId = req.admin.company._id || req.admin.company;
    GoogleAdsConfig.find({ company: companyId, isActive: true }).lean()
      .then(function (configs) { res.json({ campaigns: configs }); })
      .catch(function (err) { res.status(500).json({ message: err.message }); });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Meta ad-level (individual ad performance + creatives) ────────────────────
router.get("/meta-ad-level", protectMarketing, function (req, res) {
  try {
    const { getMetaAdLevelReport } = require("../services/metaInsightsService");
    const companyId = req.admin.company._id || req.admin.company;
    getMetaAdLevelReport({ company: companyId, from: req.query.from || null, to: req.query.to || null })
      .then(function (data) { res.json(data); })
      .catch(function (err) { res.status(500).json({ message: err.message }); });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Leads Intelligence — ad-level lead breakdown + converting leads ───────────
router.get("/leads-intelligence", protectMarketing, function (req, res) {
  try {
    const Lead      = require("../models/Leads");
    const companyId = req.admin.company._id || req.admin.company;
    const from      = req.query.from || null;
    const to        = req.query.to   || null;
    const status    = req.query.status || null;
    const campaign  = req.query.campaign || null;

    const filter = { company: companyId, mergedInto: null,
      // Only paid ad platform leads. Uses $or so leads with a metaConfigId
      // are always included even if source field was set inconsistently.
      "$or": [
        { source: { "$in": ["Meta Ads", "Meta", "Google Ads", "meta", "google", "Facebook Ads", "Instagram Ads"] } },
        { metaConfigId: { "$ne": null, "$exists": true } },
        { formId:       { "$ne": "",   "$exists": true } },
      ],
    };
    if (from || to) {
      filter.date = {};
      if (from) { const d = new Date(from); filter.date["$gte"] = d; }
      if (to)   { const d = new Date(to); d.setHours(23,59,59,999); filter.date["$lte"] = d; }
    }
    if (status)   filter.status   = status;
    if (campaign) filter.campaign = campaign;

    // Run all queries in parallel
    Promise.all([
      // 1. Ad-level (campaign + adSetName) breakdown with status counts
      Lead.aggregate([
        { "$match": filter },
        { "$group": {
          "_id": { campaign: "$campaign", adSet: "$adSetName", source: "$source" },
          total:      { "$sum": 1 },
          converted:  { "$sum": { "$cond": [{ "$eq": ["$status","Converted"] }, 1, 0] } },
          inProgress: { "$sum": { "$cond": [{ "$eq": ["$status","In Progress"] }, 1, 0] } },
          newLeads:   { "$sum": { "$cond": [{ "$eq": ["$status","New"] }, 1, 0] } },
          notInt:     { "$sum": { "$cond": [{ "$eq": ["$status","Not Interested"] }, 1, 0] } },
          verif:      { "$sum": { "$cond": [{ "$eq": ["$status","Verification"] }, 1, 0] } },
          firstLead:  { "$min": "$date" },
          lastLead:   { "$max": "$date" },
        }},
        { "$sort": { total: -1 } },
      ]),
      // 2. Converted leads with full detail
      Lead.find(Object.assign({}, filter, { status: "Converted" }))
        .select("name mobile email campaign adSetName source status date remark user language")
        .populate("user", "name")
        .sort({ date: -1 }).limit(200).lean(),
      // 3. Recent leads (all) for the table
      Lead.find(filter)
        .select("name mobile email campaign adSetName source status date remark followUpDate user language")
        .populate("user", "name")
        .sort({ date: -1 }).limit(500).lean(),
      // 4. Distinct campaigns for filter
      Lead.distinct("campaign", { company: companyId, campaign: { "$nin": [null, ""] } }),
    ]).then(function(results) {
      const adLevelRaw = results[0];
      const convertedLeads = results[1];
      const allLeads = results[2];
      const campaigns = results[3];

      // Group ad-level by campaign
      const campaignMap = {};
      for (let i = 0; i < adLevelRaw.length; i++) {
        const r = adLevelRaw[i];
        const campName = (r["_id"] && r["_id"].campaign) ? r["_id"].campaign : "Unknown";
        const adSet    = (r["_id"] && r["_id"].adSet)    ? r["_id"].adSet    : "—";
        const source   = (r["_id"] && r["_id"].source)   ? r["_id"].source   : "—";
        if (!campaignMap[campName]) campaignMap[campName] = { campaign: campName, adSets: [], total: 0, converted: 0 };
        const convRate = r.total > 0 ? Math.round((r.converted / r.total) * 10000) / 100 : 0;
        campaignMap[campName].adSets.push({
          adSet: adSet, source: source,
          total: r.total, converted: r.converted, inProgress: r.inProgress,
          newLeads: r.newLeads, notInt: r.notInt, verif: r.verif,
          convRate: convRate,
          firstLead: r.firstLead, lastLead: r.lastLead,
        });
        campaignMap[campName].total     += r.total;
        campaignMap[campName].converted += r.converted;
      }
      const adLevel = Object.values(campaignMap)
        .sort(function(a,b){ return b.total - a.total; })
        .map(function(c) {
          c.convRate = c.total > 0 ? Math.round((c.converted / c.total) * 10000) / 100 : 0;
          c.adSets = c.adSets.sort(function(a,b){ return b.total - a.total; });
          return c;
        });

      // Format lead lists
      const fmt = function(l) {
        return {
          _id:        String(l._id),
          name:       l.name || "",
          mobile:     l.mobile || "",
          email:      l.email  || "",
          campaign:   l.campaign  || "—",
          adSet:      l.adSetName || "—",
          source:     l.source    || "—",
          status:     l.status    || "",
          date:       l.date,
          remark:     l.remark    || "",
          agent:      (l.user && l.user.name) ? l.user.name : "Unassigned",
          language:   l.language  || "",
        };
      };

      res.json({
        adLevel:        adLevel,
        convertedLeads: convertedLeads.map(fmt),
        allLeads:       allLeads.map(fmt),
        filters:        { campaigns: (campaigns || []).filter(Boolean).sort() },
        range:          { from: from, to: to },
      });
    }).catch(function(err) {
      res.status(500).json({ message: err.message });
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Meta campaign detail (single config) ──────────────────────────────────────
// GET /api/marketing-panel/meta-campaign/:id?from=&to=
// Returns full detail for ONE MetaConfig: daily spend trend, audience-level
// breakdown from Insights API (age, gender, placement, device), plus CRM counts.
router.get("/meta-campaign/:id", protectMarketing, function (req, res) {
  try {
    const MetaConfig = require("../models/MetaConfig");
    const Lead       = require("../models/Leads");
    const axios      = require("axios");
    const companyId  = req.admin.company._id || req.admin.company;
    const configId   = req.params.id;

    MetaConfig.findOne({ _id: configId, company: companyId }).lean()
      .then(async function (cfg) {
        if (!cfg) return res.status(404).json({ message: "Config not found." });

        const from  = req.query.from || null;
        const to    = req.query.to   || null;
        const today = new Date();
        const daysAgo = function (d) { const dt = new Date(today); dt.setDate(dt.getDate() - d); return dt.toISOString().slice(0, 10); };
        const since = from || daysAgo(30);
        const until = to   || daysAgo(0);
        const timeRange = JSON.stringify({ since: since, until: until });

        const n = function (v) { return v != null && !isNaN(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0; };

        // CRM counts
        const crmFilter = {
          company: companyId,
          mergedInto: null,
          createdAt: { $gte: new Date(since), $lte: new Date(until + "T23:59:59Z") },
        };
        const campName = cfg.parentCampaignName || cfg.campaignName;
        if (campName) crmFilter.campaign = campName;

        const [totalLeads, convertedLeads, qualifiedLeads] = await Promise.all([
          Lead.countDocuments(crmFilter),
          Lead.countDocuments(Object.assign({}, crmFilter, { status: "Converted" })),
          Lead.countDocuments(Object.assign({}, crmFilter, { $or: [{ temperature: "Hot" }, { leadCategory: "Hot" }] })),
        ]);

        const avgDeal = Number(cfg.avgDealValue) || 0;
        const revenue = Math.round(convertedLeads * avgDeal * 100) / 100;

        if (!cfg.adAccountId || !cfg.adsToken) {
          return res.json({
            config: cfg, configured: false,
            crmLeads: totalLeads, crmConverted: convertedLeads, crmQualified: qualifiedLeads,
            revenue: revenue, roas: null,
            daily: [], breakdowns: {},
          });
        }

        const ver = cfg.graphApiVersion || "v22.0";
        const node = cfg.metaAdsetId || cfg.metaCampaignId || cfg.adAccountId;
        const level = cfg.metaAdsetId ? "adset" : cfg.metaCampaignId ? "campaign" : "account";

        // Fetch daily breakdown
        const [dailyRes, ageGenderRes, placementRes, deviceRes] = await Promise.allSettled([
          axios.get("https://graph.facebook.com/" + ver + "/" + node + "/insights", {
            params: { fields: "spend,impressions,reach,clicks,cpm,cpc,ctr,frequency", time_range: timeRange, time_increment: 1, level: level, access_token: cfg.adsToken, limit: 100 },
            timeout: 20000,
          }),
          axios.get("https://graph.facebook.com/" + ver + "/" + node + "/insights", {
            params: { fields: "spend,impressions,clicks,ctr,reach", time_range: timeRange, breakdowns: "age,gender", level: level, access_token: cfg.adsToken, limit: 200 },
            timeout: 20000,
          }),
          axios.get("https://graph.facebook.com/" + ver + "/" + node + "/insights", {
            params: { fields: "spend,impressions,clicks,ctr", time_range: timeRange, breakdowns: "publisher_platform,platform_position", level: level, access_token: cfg.adsToken, limit: 100 },
            timeout: 20000,
          }),
          axios.get("https://graph.facebook.com/" + ver + "/" + node + "/insights", {
            params: { fields: "spend,impressions,clicks,ctr", time_range: timeRange, breakdowns: "device_platform", level: level, access_token: cfg.adsToken, limit: 50 },
            timeout: 20000,
          }),
        ]);

        const daily = dailyRes.status === "fulfilled"
          ? (dailyRes.value.data.data || []).map(function (r) {
              return { date: r.date_start, spend: n(r.spend), impressions: n(r.impressions), reach: n(r.reach), clicks: n(r.clicks), cpm: n(r.cpm), cpc: n(r.cpc), ctr: n(r.ctr), frequency: n(r.frequency) };
            })
          : [];

        const ageGender = ageGenderRes.status === "fulfilled"
          ? (ageGenderRes.value.data.data || []).map(function (r) { return { age: r.age, gender: r.gender, spend: n(r.spend), impressions: n(r.impressions), clicks: n(r.clicks), ctr: n(r.ctr), reach: n(r.reach) }; })
          : [];

        const placement = placementRes.status === "fulfilled"
          ? (placementRes.value.data.data || []).map(function (r) { return { platform: r.publisher_platform, position: r.platform_position, spend: n(r.spend), impressions: n(r.impressions), clicks: n(r.clicks), ctr: n(r.ctr) }; })
          : [];

        const device = deviceRes.status === "fulfilled"
          ? (deviceRes.value.data.data || []).map(function (r) { return { device: r.device_platform, spend: n(r.spend), impressions: n(r.impressions), clicks: n(r.clicks), ctr: n(r.ctr) }; })
          : [];

        // Aggregate totals from daily
        const totalsAgg = daily.reduce(function (acc, d) {
          acc.spend += d.spend; acc.impressions += d.impressions; acc.reach += d.reach; acc.clicks += d.clicks;
          return acc;
        }, { spend: 0, impressions: 0, reach: 0, clicks: 0 });
        const roas = totalsAgg.spend > 0 && revenue > 0 ? Math.round((revenue / totalsAgg.spend) * 100) / 100 : null;

        return res.json({
          config: cfg, configured: true,
          totals: totalsAgg,
          crmLeads: totalLeads, crmConverted: convertedLeads, crmQualified: qualifiedLeads,
          revenue: revenue, roas: roas, avgDealValue: avgDeal,
          daily: daily,
          breakdowns: { ageGender: ageGender, placement: placement, device: device },
        });
      })
      .catch(function (err) { res.status(500).json({ message: err.message }); });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Google Ads campaign detail ─────────────────────────────────────────────────
// GET /api/marketing-panel/google-campaign/:id?from=&to=
// Returns detail for ONE GoogleAdsConfig including CRM counts and ROAS.
router.get("/google-campaign/:id", protectMarketing, function (req, res) {
  try {
    const GoogleAdsConfig = require("../models/GoogleAdsConfig");
    const Lead            = require("../models/Leads");
    const companyId       = req.admin.company._id || req.admin.company;
    const configId        = req.params.id;
    const from            = req.query.from || null;
    const to              = req.query.to   || null;
    const today           = new Date();
    const daysAgo         = function (d) { const dt = new Date(today); dt.setDate(dt.getDate() - d); return dt.toISOString().slice(0, 10); };
    const since           = from || daysAgo(30);
    const until           = to   || daysAgo(0);

    GoogleAdsConfig.findOne({ _id: configId, company: companyId }).lean()
      .then(async function (cfg) {
        if (!cfg) return res.status(404).json({ message: "Config not found." });

        const crmFilter = {
          company: companyId, mergedInto: null,
          createdAt: { $gte: new Date(since), $lte: new Date(until + "T23:59:59Z") },
          campaign: cfg.campaignName,
        };
        const [totalLeads, convertedLeads, qualifiedLeads] = await Promise.all([
          Lead.countDocuments(crmFilter),
          Lead.countDocuments(Object.assign({}, crmFilter, { status: "Converted" })),
          Lead.countDocuments(Object.assign({}, crmFilter, { $or: [{ temperature: "Hot" }, { leadCategory: "Hot" }] })),
        ]);

        const avgDeal = Number(cfg.avgDealValue) || 0;
        const revenue = Math.round(convertedLeads * avgDeal * 100) / 100;
        const spend   = Number(cfg.cost) || 0;
        const roas    = spend > 0 && revenue > 0 ? Math.round((revenue / spend) * 100) / 100 : null;
        const cpl     = totalLeads > 0 ? Math.round((spend / totalLeads) * 100) / 100 : null;

        return res.json({
          config: cfg, configured: true,
          crmLeads: totalLeads, crmConverted: convertedLeads, crmQualified: qualifiedLeads,
          revenue: revenue, roas: roas, avgDealValue: avgDeal,
          spend: spend, cpl: cpl,
          from: since, to: until,
        });
      })
      .catch(function (err) { res.status(500).json({ message: err.message }); });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Google Ads full campaign list with CRM stats ──────────────────────────────
// GET /api/marketing-panel/google-campaigns?from=&to=
router.get("/google-campaigns", protectMarketing, function (req, res) {
  try {
    const GoogleAdsConfig = require("../models/GoogleAdsConfig");
    const Lead            = require("../models/Leads");
    const companyId       = req.admin.company._id || req.admin.company;
    const from  = req.query.from || null;
    const to    = req.query.to   || null;
    const today = new Date();
    const daysAgo = function (d) { const dt = new Date(today); dt.setDate(dt.getDate() - d); return dt.toISOString().slice(0, 10); };
    const since = from || daysAgo(30);
    const until = to   || daysAgo(0);

    GoogleAdsConfig.find({ company: companyId }).lean()
      .then(async function (configs) {
        const enriched = await Promise.all(configs.map(async function (cfg) {
          const crmFilter = {
            company: companyId, mergedInto: null,
            createdAt: { $gte: new Date(since), $lte: new Date(until + "T23:59:59Z") },
            campaign: cfg.campaignName,
          };
          const [leads, converted, qualified] = await Promise.all([
            Lead.countDocuments(crmFilter),
            Lead.countDocuments(Object.assign({}, crmFilter, { status: "Converted" })),
            Lead.countDocuments(Object.assign({}, crmFilter, { $or: [{ temperature: "Hot" }, { leadCategory: "Hot" }] })),
          ]);
          const avgDeal = Number(cfg.avgDealValue) || 0;
          const revenue = Math.round(converted * avgDeal * 100) / 100;
          const spend   = Number(cfg.cost) || 0;
          const roas    = spend > 0 && revenue > 0 ? Math.round((revenue / spend) * 100) / 100 : null;
          const cpl     = leads > 0 ? Math.round((spend / leads) * 100) / 100 : null;
          const convRate = leads > 0 ? Math.round((converted / leads) * 10000) / 100 : 0;
          return Object.assign({}, cfg, { crmLeads: leads, crmConverted: converted, crmQualified: qualified, revenue: revenue, roas: roas, cpl: cpl, convRate: convRate });
        }));

        const totals = enriched.reduce(function (acc, c) {
          acc.spend       += Number(c.cost)       || 0;
          acc.impressions += Number(c.impressions) || 0;
          acc.clicks      += Number(c.clicks)      || 0;
          acc.leads       += c.crmLeads;
          acc.converted   += c.crmConverted;
          acc.qualified   += c.crmQualified;
          acc.revenue     += c.revenue;
          return acc;
        }, { spend: 0, impressions: 0, clicks: 0, leads: 0, converted: 0, qualified: 0, revenue: 0 });
        const totalRoas = totals.spend > 0 && totals.revenue > 0 ? Math.round((totals.revenue / totals.spend) * 100) / 100 : null;

        return res.json({ campaigns: enriched, totals: Object.assign({}, totals, { roas: totalRoas }), range: { from: since, to: until } });
      })
      .catch(function (err) { res.status(500).json({ message: err.message }); });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Reports — scheduled summary ───────────────────────────────────────────────
// GET /api/marketing-panel/reports/summary?from=&to=
// Generates a combined Meta + Google + CRM summary suitable for export/email.
router.get("/reports/summary", protectMarketing, function (req, res) {
  try {
    const Lead            = require("../models/Leads");
    const MetaConfig      = require("../models/MetaConfig");
    const GoogleAdsConfig = require("../models/GoogleAdsConfig");
    const companyId       = req.admin.company._id || req.admin.company;
    const from  = req.query.from || null;
    const to    = req.query.to   || null;
    const today = new Date();
    const daysAgo = function (d) { const dt = new Date(today); dt.setDate(dt.getDate() - d); return dt.toISOString().slice(0, 10); };
    const since = from || daysAgo(30);
    const until = to   || daysAgo(0);
    const fromD = new Date(since);
    const toD   = new Date(until + "T23:59:59Z");

    Promise.all([
      // Overall CRM pipeline
      Lead.aggregate([
        { $match: { company: companyId, mergedInto: null, createdAt: { $gte: fromD, $lte: toD } } },
        { $group: {
          _id: null,
          total:      { $sum: 1 },
          converted:  { $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq: ["$status", "In Progress"] }, 1, 0] } },
          newLeads:   { $sum: { $cond: [{ $eq: ["$status", "New"] }, 1, 0] } },
          notInt:     { $sum: { $cond: [{ $eq: ["$status", "Not Interested"] }, 1, 0] } },
          hotLeads:   { $sum: { $cond: [{ $in: ["$temperature", ["Hot"]] }, 1, 0] } },
        }},
      ]),
      // Per-source breakdown
      Lead.aggregate([
        { $match: { company: companyId, mergedInto: null, createdAt: { $gte: fromD, $lte: toD } } },
        { $group: {
          _id: "$source",
          total:     { $sum: 1 },
          converted: { $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] } },
        }},
        { $sort: { total: -1 } },
      ]),
      // Per-campaign breakdown
      Lead.aggregate([
        { $match: { company: companyId, mergedInto: null, createdAt: { $gte: fromD, $lte: toD } } },
        { $group: {
          _id: "$campaign",
          total:     { $sum: 1 },
          converted: { $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] } },
        }},
        { $sort: { total: -1 } },
        { $limit: 20 },
      ]),
      // Per-employee performance
      Lead.aggregate([
        { $match: { company: companyId, mergedInto: null, createdAt: { $gte: fromD, $lte: toD }, user: { $ne: null } } },
        { $group: {
          _id: "$user",
          total:     { $sum: 1 },
          converted: { $sum: { $cond: [{ $eq: ["$status", "Converted"] }, 1, 0] } },
        }},
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "userInfo" } },
        { $project: {
          name:      { $arrayElemAt: ["$userInfo.name", 0] },
          total: 1,  converted: 1,
          convRate:  { $cond: [{ $gt: ["$total", 0] }, { $multiply: [{ $divide: ["$converted", "$total"] }, 100] }, 0] },
        }},
        { $sort: { converted: -1 } },
        { $limit: 20 },
      ]),
      // Meta spend total (from MetaConfig stored fields)
      MetaConfig.aggregate([
        { $match: { company: companyId } },
      ]),
      // Google spend total
      GoogleAdsConfig.aggregate([
        { $match: { company: companyId } },
      ]),
    ]).then(function (results) {
      const pipeline  = (results[0] && results[0][0]) ? results[0][0] : { total: 0, converted: 0, inProgress: 0, newLeads: 0, notInt: 0, hotLeads: 0 };
      const bySrc     = results[1].map(function (r) { return { source: r._id || "Unknown", total: r.total, converted: r.converted, convRate: r.total > 0 ? Math.round((r.converted / r.total) * 10000) / 100 : 0 }; });
      const byCamp    = results[2].map(function (r) { return { campaign: r._id || "Unknown", total: r.total, converted: r.converted }; });
      const byEmp     = results[3].map(function (r) { return { name: r.name || "Unassigned", total: r.total, converted: r.converted, convRate: Math.round((r.convRate || 0) * 100) / 100 }; });
      const metaCfgs  = results[4];
      const gCfgs     = results[5];

      const googleSpend = gCfgs.reduce(function (s, c) { return s + (Number(c.cost) || 0); }, 0);
      const convRate = pipeline.total > 0 ? Math.round((pipeline.converted / pipeline.total) * 10000) / 100 : 0;

      res.json({
        range: { from: since, to: until },
        pipeline: Object.assign({}, pipeline, { convRate: convRate }),
        bySrc: bySrc,
        byCamp: byCamp,
        byEmployee: byEmp,
        adSpend: { google: Math.round(googleSpend * 100) / 100 },
        metaCampaigns: metaCfgs.length,
        googleCampaigns: gCfgs.length,
        generatedAt: new Date().toISOString(),
      });
    }).catch(function (err) { res.status(500).json({ message: err.message }); });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
