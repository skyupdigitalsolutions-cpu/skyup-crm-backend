// routes/websiteConfig.js — UPDATED
// Added requireFeature("websiteTracking") gate to all website config routes.
// The existing checkLimit("websites") on POST is preserved.
// GET (read) routes are also gated so companies without websiteTracking
// cannot even list website integrations.

const express = require("express");
const router = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { checkLimit, requireFeature } = require("../middlewares/entitlementMiddleware");
const WebsiteConfig = require("../models/WebsiteConfig");
const {
  getConfigs,
  claimWebsiteConfigOwnership,
  createConfig,
  updateConfig,
  toggleConfig,
  deleteConfig,
  getInsights,
} = require("../controllers/websiteConfigController");

// Count existing website configs for the caller's company.
const countCompanyWebsiteConfigs = async (req) => {
  const companyId = req.admin?.company?._id || req.admin?.company || null;
  if (!companyId) return 0;
  return WebsiteConfig.countDocuments({ company: companyId });
};

// All routes require websiteTracking feature
router.get("/",    protectAdmin, requireFeature("websiteTracking"), getConfigs);
router.get("/insights", protectAdmin, requireFeature("websiteTracking"), getInsights); // ← Website performance report
router.post(
  "/",
  protectAdmin,
  requireFeature("websiteTracking"),
  checkLimit("websites", countCompanyWebsiteConfigs), // limit gate: max website integrations
  createConfig,
);
router.put("/:id",           protectAdmin, requireFeature("websiteTracking"), updateConfig);
router.patch("/:id/toggle",  protectAdmin, requireFeature("websiteTracking"), toggleConfig);
router.delete("/:id",        protectAdmin, requireFeature("websiteTracking"), deleteConfig);

module.exports = router;

router.post("/claim-ownership", protectAdmin, claimWebsiteConfigOwnership);

module.exports = router;
