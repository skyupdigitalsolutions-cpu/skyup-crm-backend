const express = require("express");
const router = express.Router();
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  getEmailHistory,
  getEmailLogById,
  deleteEmailLog,
  getDistinctCampaigns,
} = require("../controllers/emailCampaignController");

// GET  /api/email/history/campaigns  → distinct campaign IDs for filter dropdown
// ⚠️  Must come BEFORE /:id so "campaigns" isn't matched as an id param
router.get("/history/campaigns", protectAdmin, getDistinctCampaigns);

// GET  /api/email/history            → paginated list with search & filter
router.get("/history", protectAdmin, getEmailHistory);

// GET  /api/email/history/:id        → single log with full body
router.get("/history/:id", protectAdmin, getEmailLogById);

// DELETE /api/email/history/:id      → remove a log entry
router.delete("/history/:id", protectAdmin, deleteEmailLog);

module.exports = router;