const express = require("express");
const router  = express.Router();
const {
  sendBulkEmails,
  previewCampaign,
  sendSingleEmail,
  sendCsvEmails,
} = require("../controllers/emailCampaignController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// GET  /api/email-campaign/preview?campaign=XYZ  → shows how many leads will receive the email
router.get("/preview", protectAdmin, previewCampaign);

// POST /api/email-campaign/send                  → fires the bulk personalized emails (by campaign)
router.post("/send", protectAdmin, sendBulkEmails);

// POST /api/email-campaign/send-single           → sends to a single lead
router.post("/send-single", protectAdmin, sendSingleEmail);

// POST /api/email-campaign/send-csv              → sends to a list of recipients from CSV
router.post("/send-csv", protectAdmin, sendCsvEmails);

module.exports = router;