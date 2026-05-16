// routes/smsHistory.js
// SMS log / history routes

const express = require("express");
const router  = express.Router();

const {
  getSmsHistory,
  getSmsCampaigns,
  deleteSmsLog,
} = require("../controllers/smsCampaignController");

const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// GET  /api/sms/history/campaigns   → distinct campaign names
router.get("/history/campaigns", protectAdmin, getSmsCampaigns);

// GET  /api/sms/history             → paginated log
router.get("/history", protectAdmin, getSmsHistory);

// DELETE /api/sms/history/:id
router.delete("/history/:id", protectAdmin, deleteSmsLog);

module.exports = router;