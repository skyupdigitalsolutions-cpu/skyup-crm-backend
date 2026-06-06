// routes/smsCampaign.js
// SMS blasting routes — admin-role protected
// Bulk blast (send / send-csv) requires super_admin role.
// Single send and preview are open to all admins.

const express = require("express");
const router  = express.Router();

const {
  sendBulkSms,
  sendSingleSms,
  sendCsvSms,
  previewSmsCampaign,
} = require("../controllers/smsCampaignController");

const {
  protectAdmin,
  requireCompanySuperAdmin,
} = require("../middlewares/adminAuthMiddleware");

const { requireFeature } = require("../middlewares/entitlementMiddleware");

// GET  /api/sms-campaign/preview?campaign=XYZ  — any admin can preview
router.get("/preview", protectAdmin, previewSmsCampaign);

// POST /api/sms-campaign/send          → CRM campaign leads (super_admin only, smsBlast feature required)
router.post("/send", protectAdmin, requireCompanySuperAdmin, requireFeature("smsBlast"), sendBulkSms);

// POST /api/sms-campaign/send-single   → one number (any admin, smsBlast feature required)
router.post("/send-single", protectAdmin, requireFeature("smsBlast"), sendSingleSms);

// POST /api/sms-campaign/send-csv      → CSV list (super_admin only, smsBlast feature required)
router.post("/send-csv", protectAdmin, requireCompanySuperAdmin, requireFeature("smsBlast"), sendCsvSms);

module.exports = router;