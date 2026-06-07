const express = require("express");
const router = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { checkLimit } = require("../middlewares/entitlementMiddleware");
const WebsiteConfig = require("../models/WebsiteConfig");
const {
  getConfigs,
  createConfig,
  updateConfig,
  toggleConfig,
  deleteConfig,
} = require("../controllers/websiteConfigController");

// Count existing website configs for the caller's company.
const countCompanyWebsiteConfigs = async (req) => {
  const companyId = req.admin?.company?._id || req.admin?.company || null;
  if (!companyId) return 0;
  return WebsiteConfig.countDocuments({ company: companyId });
};

router.get("/", protectAdmin, getConfigs);
router.post(
  "/",
  protectAdmin,
  checkLimit("websites", countCompanyWebsiteConfigs), // limit gate: max website integrations
  createConfig,
);
router.put("/:id", protectAdmin, updateConfig);
router.patch("/:id/toggle", protectAdmin, toggleConfig);
router.delete("/:id", protectAdmin, deleteConfig);

module.exports = router;
