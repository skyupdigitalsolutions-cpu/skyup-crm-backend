// models/SmsConfig.js
// Stores MSG91 SMS credentials per company — same pattern as WhatsAppConfig
// One company = one SMS config

const mongoose = require("mongoose");
const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");

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

    // ── Skyup_greetings approved DLT template ──────────────────────────────
    // Sender ID registered with MSG91: 695382
    // DLT Template ID (TRAI):   1007503933418344595  ← NOT used in API calls
    // MSG91 Flow ID (API field): 6a1ffe028c6272147b00b233  ← THIS is what goes in flow_id
    // The /api/v5/flow/ endpoint uses flow_id = the MSG91 Template/Flow ID, NOT the DLT ID.
    greetingsTemplateId: {
      type:    String,
      default: "6a1ffe028c6272147b00b233",   // ✅ MSG91 Flow ID (not the DLT number)
      trim:    true,
    },

    greetingsSenderId: {
      type:    String,
      default: "695382",
      trim:    true,
    },

    isActive: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

smsConfigSchema.plugin(encryptedFieldsPlugin, {
  fields: ["msg91AuthKey"],
});

module.exports = mongoose.model("SmsConfig", smsConfigSchema);