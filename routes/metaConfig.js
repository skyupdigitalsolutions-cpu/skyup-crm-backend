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
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// All routes protected — company is derived from req.admin inside the controller
router.get("/", protectAdmin, getAllConfigs);
router.get("/:id", protectAdmin, getConfigById);
router.post("/", protectAdmin, addConfig);
router.put("/:id", protectAdmin, updateConfig);
router.patch("/:id/toggle", protectAdmin, toggleConfig);
router.delete("/:id", protectAdmin, deleteConfig);

module.exports = router;