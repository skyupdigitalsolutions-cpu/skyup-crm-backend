const express = require("express");
const router  = express.Router();
const {
  sendBulkEmails,
  previewCampaign,
  sendSingleEmail,
  sendCsvEmails,
} = require("../controllers/emailCampaignController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { requireFeature } = require("../middlewares/entitlementMiddleware");

// GET  /api/email-campaign/preview?campaign=XYZ
router.get("/preview", protectAdmin, previewCampaign);

// POST /api/email-campaign/send — requires emailBlast feature
router.post("/send", protectAdmin, requireFeature("emailBlast"), sendBulkEmails);

// POST /api/email-campaign/send-single — requires emailBlast feature
router.post("/send-single", protectAdmin, requireFeature("emailBlast"), sendSingleEmail);

// POST /api/email-campaign/send-csv — requires emailBlast feature
router.post("/send-csv", protectAdmin, requireFeature("emailBlast"), sendCsvEmails);

module.exports = router;