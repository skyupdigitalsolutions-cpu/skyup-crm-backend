// controllers/smsConfigController.js
// GET and PUT MSG91 SMS credentials for the logged-in company
// Same pattern as metaConfigController / whatsappChatController

const SmsConfig = require("../models/SmsConfig");

// GET /api/sms-config
// Returns this company's saved SMS config (auth key is returned for editing)
const getSmsConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const config = await SmsConfig.findOne({ company: companyId });
    res.json({ success: true, data: config || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /api/sms-config
// Save (upsert) MSG91 credentials for this company
const saveSmsConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { msg91AuthKey, msg91SenderId } = req.body;

    if (!msg91AuthKey || !msg91AuthKey.trim()) {
      return res.status(400).json({ message: "MSG91 Auth Key is required" });
    }

    const config = await SmsConfig.findOneAndUpdate(
      { company: companyId },
      {
        msg91AuthKey:  msg91AuthKey.trim(),
        msg91SenderId: (msg91SenderId || "SKYCRM").trim().toUpperCase(),
        isActive:      true,
      },
      { upsert: true, new: true, runValidators: true }
    );

    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getSmsConfig, saveSmsConfig };