// routes/smsConfig.js
// Protected route — only logged-in admins can read/write their SMS config

const express    = require("express");
const router     = express.Router();
const { getSmsConfig, saveSmsConfig } = require("../controllers/smsConfigController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// GET  /api/sms-config  → fetch saved credentials
router.get("/", protectAdmin, getSmsConfig);

// PUT  /api/sms-config  → save/update credentials
router.put("/", protectAdmin, saveSmsConfig);

module.exports = router;