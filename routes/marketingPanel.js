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
        .sort({ date: -1 }).limit(200).lean(),
      // 3. Recent leads (all) for the table
      Lead.find(filter)
        .select("name mobile email campaign adSetName source status date remark followUpDate user language")
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

module.exports = router;
