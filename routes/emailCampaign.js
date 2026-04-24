const express = require("express");
const router  = express.Router();
const {
  sendBulkEmails,
  previewCampaign,
  sendSingleEmail,
  sendCsvEmails,
} = require("../controllers/emailCampaignController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// GET  /api/email-campaign/preview?campaign=XYZ
router.get("/preview", protectAdmin, previewCampaign);

// POST /api/email-campaign/send
router.post("/send", protectAdmin, sendBulkEmails);

// POST /api/email-campaign/send-single
router.post("/send-single", protectAdmin, sendSingleEmail);

// POST /api/email-campaign/send-csv
router.post("/send-csv", protectAdmin, sendCsvEmails);

module.exports = router;