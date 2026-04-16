const express = require("express");
const router  = express.Router();
const { sendBulkEmails, previewCampaign } = require("../controllers/emailCampaignController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// GET  /api/email-campaign/preview?campaign=XYZ  → shows how many leads will receive the email
router.get("/preview", protectAdmin, previewCampaign);

// POST /api/email-campaign/send                  → fires the bulk personalized emails
router.post("/send", protectAdmin, sendBulkEmails);

module.exports = router;