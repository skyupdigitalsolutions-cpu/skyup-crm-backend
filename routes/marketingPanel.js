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

module.exports = router;
