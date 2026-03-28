const express = require("express");
const router = express.Router();
const {
  getAllConfigs,
  getConfigById,
  addConfig,
  updateConfig,
  toggleConfig,
  deleteConfig,
} = require("../controllers/metaConfigController");

// Auth temporarily removed — add back once confirmed
router.get("/", getAllConfigs);
router.get("/:id", getConfigById);
router.post("/", addConfig);
router.put("/:id", updateConfig);
router.patch("/:id/toggle", toggleConfig);
router.delete("/:id", deleteConfig);

module.exports = router;