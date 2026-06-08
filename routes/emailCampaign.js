const express = require("express");
const router  = express.Router();
const {
  sendBulkEmails,
  previewCampaign,
  sendSingleEmail,
  sendCsvEmails,
  getBrevoStatus,
  getMsg91EmailStatus,
} = require("../controllers/emailCampaignController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { requireFeature } = require("../middlewares/entitlementMiddleware");

// GET  /api/email-campaign/preview?campaign=XYZ
router.get("/preview", protectAdmin, previewCampaign);

// GET  /api/email-campaign/brevo-status
router.get("/brevo-status", protectAdmin, getBrevoStatus);

// GET  /api/email-campaign/msg91-email-status
router.get("/msg91-email-status", protectAdmin, getMsg91EmailStatus);

// POST /api/email-campaign/send — requires emailBlast feature
router.post("/send", protectAdmin, requireFeature("emailBlast"), sendBulkEmails);

// POST /api/email-campaign/send-single — requires emailBlast feature
router.post("/send-single", protectAdmin, requireFeature("emailBlast"), sendSingleEmail);

// POST /api/email-campaign/send-csv — requires emailBlast feature
router.post("/send-csv", protectAdmin, requireFeature("emailBlast"), sendCsvEmails);

module.exports = router;