const express = require("express");
const router = express.Router();
const {
  getAllConfigs,
  claimMetaConfigOwnership,
  getConfigById,
  addConfig,
  updateConfig,
  toggleConfig,
  deleteConfig,
  getInsights,
  getAdLevelInsights,
} = require("../controllers/metaConfigController");
const { syncFromMeta } = require("../controllers/metaSyncController");
const { getFormQuestions } = require("../controllers/metaQualificationController");
const { testConnection, discover, connectionStatus, pageLeads } = require("../controllers/metaConnectionController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { checkLimit, requireFeature } = require("../middlewares/entitlementMiddleware");
const MetaConfig = require("../models/MetaConfig");

// Count existing Meta campaign configs for the caller's company.
const countCompanyMetaConfigs = async (req) => {
  const companyId = req.admin?.company?._id || req.admin?.company || null;
  if (!companyId) return 0;
  return MetaConfig.countDocuments({ company: companyId });
};

// All routes protected — company is derived from req.admin inside the controller
router.get("/", protectAdmin, getAllConfigs);
router.get("/insights",   protectAdmin, getInsights);       // ← campaign/adset performance report
router.get("/ad-level",   protectAdmin, getAdLevelInsights); // ← individual ad performance + creatives
// Connection helpers — specific paths BEFORE /:id so they aren't captured as an id.
router.get("/connection-status", protectAdmin, connectionStatus);  // per-config status badges
router.get("/page-leads", protectAdmin, pageLeads);                // page-level leads grouped by ad set
router.post("/test-connection", protectAdmin, testConnection);     // verify creds live
router.get("/:adSetId/form-questions", protectAdmin, getFormQuestions); // ← Qualification: fetch Meta form questions
router.get("/:id/discover", protectAdmin, discover);               // live ad sets + forms for a config
router.get("/:id", protectAdmin, getConfigById);
router.post("/sync", protectAdmin, syncFromMeta);   // ← FIX: Auto-Sync from Meta
router.post(
  "/",
  protectAdmin,
  requireFeature("metaAds"),                                 // feature gate: Meta Ads must be enabled
  checkLimit("metaCampaigns", countCompanyMetaConfigs),      // limit gate: max Meta campaigns
  addConfig,
);
router.put("/:id", protectAdmin, updateConfig);
router.patch("/:id/toggle", protectAdmin, requireFeature("metaAds"), toggleConfig);
router.delete("/:id", protectAdmin, deleteConfig);

module.exports = router;

router.post("/claim-ownership", protectAdmin, requireCompanySuperAdmin, claimMetaConfigOwnership);

module.exports = router;
