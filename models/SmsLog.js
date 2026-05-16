// models/SmsLog.js
// Tracks every SMS sent via MSG91 (bulk, single, or CSV)

const mongoose = require("mongoose");

const smsLogSchema = new mongoose.Schema(
  {
    to: {
      type: String,
      required: true,
      trim: true,
    },
    recipientName: {
      type: String,
      default: "",
    },
    message: {
      type: String,
      required: true,
    },
    // MSG91 template ID used (optional, for DLT-registered templates)
    templateId: {
      type: String,
      default: null,
    },
    // Sender ID (e.g. "SKYCRM")
    senderId: {
      type: String,
      default: null,
    },
    // campaign name / identifier (if sent via campaign mode)
    campaignId: {
      type: String,
      default: null,
    },
    // "sent" | "failed"
    status: {
      type: String,
      enum: ["sent", "failed"],
      default: "sent",
    },
    errorMessage: {
      type: String,
      default: null,
    },
    // MSG91 requestId returned on success
    msg91RequestId: {
      type: String,
      default: null,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

smsLogSchema.index({ company: 1, sentAt: -1 });
smsLogSchema.index({ company: 1, campaignId: 1 });

module.exports = mongoose.model("SmsLog", smsLogSchema);