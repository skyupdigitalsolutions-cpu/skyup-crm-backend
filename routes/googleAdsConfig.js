const express = require("express");
const router  = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware"); // ✅ correct name
const { checkLimit, requireFeature } = require("../middlewares/entitlementMiddleware");
const GoogleAdsConfig = require("../models/GoogleAdsConfig");
const {
  getConfigs, createConfig, toggleConfig, deleteConfig, getInsights,
} = require("../controllers/googleAdsConfigController");

// Count existing Google Ads configs for the caller's company.
const countCompanyGoogleConfigs = async (req) => {
  const companyId = req.admin?.company?._id || req.admin?.company || null;
  if (!companyId) return 0;
  return GoogleAdsConfig.countDocuments({ company: companyId });
};

router.get("/",             protectAdmin, getConfigs);
router.get("/insights",     protectAdmin, getInsights); // ← Google Ads performance report
router.post(
  "/",
  protectAdmin,
  requireFeature("googleAds"),                              // feature gate: Google Ads must be enabled
  checkLimit("googleAccounts", countCompanyGoogleConfigs),  // limit gate: max Google accounts
  createConfig,
);
router.patch("/:id/toggle", protectAdmin, requireFeature("googleAds"), toggleConfig);
router.delete("/:id",       protectAdmin, requireFeature("googleAds"), deleteConfig);

module.exports = router;
