// models/SmsConfig.js
// Stores MSG91 SMS credentials per company — same pattern as WhatsAppConfig
// One company = one SMS config

const mongoose = require("mongoose");

const smsConfigSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      unique: true, // one SMS config per company
    },

    // MSG91 Auth Key — get from MSG91 Dashboard → API → Auth Key
    // Example: "447171TxxxXXXX67f2b4e5"
    msg91AuthKey: {
      type: String,
      default: "",
      trim: true,
    },

    // Sender ID — 6-char DLT-approved header
    // Example: "SKYCRM"
    msg91SenderId: {
      type: String,
      default: "SKYCRM",
      trim: true,
    },

    isActive: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SmsConfig", smsConfigSchema);