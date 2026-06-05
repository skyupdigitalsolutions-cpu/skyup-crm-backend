// routes/smsCampaignEmployee.js
// Employee-facing SMS blasting routes — protected by employee JWT (`protect`).
// These are scoped to the logged-in employee's assigned leads only.

const express = require("express");
const router  = express.Router();

const {
  employeePreviewSmsCampaign,
  employeeGetMyCampaigns,
  employeeSendBulkSms,
  employeeSendSingleSms,
  employeeSendCsvSms,
  employeeGetSmsConfig,
} = require("../controllers/smsCampaignController");

const { protect } = require("../middlewares/authMiddleware");

// GET  /api/sms-campaign/employee/preview?campaign=XYZ  — count of my leads
router.get("/preview",      protect, employeePreviewSmsCampaign);

// GET  /api/sms-campaign/employee/my-campaigns           — distinct campaigns I'm assigned to
router.get("/my-campaigns", protect, employeeGetMyCampaigns);

// GET  /api/sms-campaign/employee/config                 — read SMS config (masked)
router.get("/config",       protect, employeeGetSmsConfig);

// POST /api/sms-campaign/employee/send          → blast to all my assigned leads
router.post("/send",        protect, employeeSendBulkSms);

// POST /api/sms-campaign/employee/send-single   → one number
router.post("/send-single", protect, employeeSendSingleSms);

// POST /api/sms-campaign/employee/send-csv      → CSV list
router.post("/send-csv",    protect, employeeSendCsvSms);

module.exports = router;