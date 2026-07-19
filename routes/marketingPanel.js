// routes/marketingPanel.js
// Dedicated routes for the Performance Marketing Panel (separate login/panel).
// All routes protected by marketingAuthMiddleware (admin-only, no employees).

const express  = require("express");
const router   = express.Router();
const { protectMarketing } = require("../middlewares/marketingAuthMiddleware");
const { getMarketingDashboard } = require("../controllers/adminController");

// ── Marketing panel auth check (used by frontend on load) ─────────────────────
// Returns the logged-in admin's info so the panel knows who is viewing.
router.get("/me", protectMarketing, function (req, res) {
  const admin = req.admin;
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

module.exports = router;
