// routes/smsCampaign.js
// SMS blasting routes — protected by admin auth middleware

const express = require("express");
const router  = express.Router();

const {
  sendBulkSms,
  sendSingleSms,
  sendCsvSms,
  previewSmsCampaign,
} = require("../controllers/smsCampaignController");

const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// GET  /api/sms-campaign/preview?campaign=XYZ
router.get("/preview", protectAdmin, previewSmsCampaign);

// POST /api/sms-campaign/send          → CRM campaign leads
router.post("/send", protectAdmin, sendBulkSms);

// POST /api/sms-campaign/send-single   → one number
router.post("/send-single", protectAdmin, sendSingleSms);

// POST /api/sms-campaign/send-csv      → CSV list
router.post("/send-csv", protectAdmin, sendCsvSms);

module.exports = router;