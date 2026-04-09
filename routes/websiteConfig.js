const express      = require("express");
const router       = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  getConfigs, createConfig, updateConfig, toggleConfig, deleteConfig,
} = require("../controllers/websiteConfigController");

router.get("/",             protectAdmin, getConfigs);
router.post("/",            protectAdmin, createConfig);
router.put("/:id",          protectAdmin, updateConfig);
router.patch("/:id/toggle", protectAdmin, toggleConfig);
router.delete("/:id",       protectAdmin, deleteConfig);

module.exports = router;