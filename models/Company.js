// models/Company.js
const mongoose = require("mongoose");

const companySchema = mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    email:   { type: String, required: true, trim: true, unique: true },
    phone:   { type: String, trim: true },
    plan:    { type: String, enum: ["basic", "pro", "enterprise"], default: "basic" },
    isActive:{ type: Boolean, default: true },

    encryptionKeyHash: {
      type: String,
      default: null,
    },

    // ── Subscription & Expiry ─────────────────────────────────────────────────
    subscriptionExpiry: {
      type: Date,
      default: null,
    },
    subscriptionStatus: {
      type: String,
      enum: ["active", "expired", "trial", "cancelled"],
      default: "trial",
    },
    trialEndsAt: {
      type: Date,
      default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14-day free trial
    },

    // ── Data Privacy Settings ─────────────────────────────────────────────────
    dataEncryptionEnabled: {
      type: Boolean,
      default: false, // becomes true after client completes BIP39 setup
    },

    // ── FIX 4D: Atomic round-robin index (replaces N+1 countDocuments loop) ──
    roundRobinIndex: {
      type: Number,
      default: 0,
    },

    // ── Auto-template settings for new leads ─────────────────────────────────
    // When enabled, every new lead automatically receives a template message
    autoTemplate: {
      whatsapp: {
        enabled:      { type: Boolean, default: false },
        templateName: { type: String,  default: "crm_lead_followup" },
        languageCode: { type: String,  default: "en_US" },
      },
      email: {
        enabled:      { type: Boolean, default: false },
        subject:      { type: String,  default: "Welcome! We'll be in touch soon." },
        fromName:     { type: String,  default: "" },
        bodyTemplate: { type: String,  default: "<p>Hi {{name}},</p><p>Thank you for your interest. Our team will reach out to you shortly.</p><p>Regards,<br/>The Team</p>" },
      },
      sms: {
        enabled:    { type: Boolean, default: false },
        message:    { type: String,  default: "Hi {{name}}, thanks for your interest! Our team will contact you soon." },
        templateId: { type: String,  default: "" },
        senderId:   { type: String,  default: "" },
      },
    },
  },
  { timestamps: true }
);

const Company = mongoose.model("Company", companySchema);
module.exports = Company;