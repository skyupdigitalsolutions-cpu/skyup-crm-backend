const express = require("express");
const router  = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware"); // ✅ correct name
const {
  getConfigs, createConfig, toggleConfig, deleteConfig,
} = require("../controllers/googleAdsConfigController");

router.get("/",             protectAdmin, getConfigs);
router.post("/",            protectAdmin, createConfig);
router.patch("/:id/toggle", protectAdmin, toggleConfig);
router.delete("/:id",       protectAdmin, deleteConfig);

module.exports = router;