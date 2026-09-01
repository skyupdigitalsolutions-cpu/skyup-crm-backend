const express = require("express");
const router = express.Router();
const {
  getAllConfigs,
  getConfigById,
  addConfig,
  updateConfig,
  toggleConfig,
  deleteConfig,
} = require("../controllers/linkedinConfigController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { requireFeature } = require("../middlewares/entitlementMiddleware");

// All routes protected — company is derived from req.admin inside the controller
router.get("/", protectAdmin, getAllConfigs);
router.get("/:id", protectAdmin, getConfigById);
router.post("/", protectAdmin, requireFeature("linkedInAds"), addConfig);
router.put("/:id", protectAdmin, updateConfig);
router.patch("/:id/toggle", protectAdmin, requireFeature("linkedInAds"), toggleConfig);
router.delete("/:id", protectAdmin, deleteConfig);

module.exports = router;
