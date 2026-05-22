// models/Company.js — UPDATED (added 10 new fields; all existing fields unchanged)
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

    // ── Company Branding (set by SuperAdmin) ──────────────────────────────────
    brandName: {
      type: String,
      default: "",
      trim: true,
    },
    brandLogoUrl: {
      type: String,
      default: "",
      trim: true,
    },

    // ── Header Bar Branding (set by Developer per-company) ────────────────────
    // Shown in the sticky top header bar for that company's users/admins.
    // The sidebar always shows the platform logo (SKYUP); only the header differs.
    headerName: {
      type: String,
      default: "",
      trim: true,
    },
    headerLogoUrl: {
      type: String,
      default: "",
      trim: true,
    },

    // ── NEW: Extended Branding & Media ────────────────────────────────────────
    logo:    { type: String, default: "" },
    favicon: { type: String, default: "" },
    website: { type: String, default: "" },
    address: { type: String, default: "" },

    // ── NEW: Theme Colors ─────────────────────────────────────────────────────
    companyPrimaryColor:   { type: String, default: "#2563EB" },
    companySecondaryColor: { type: String, default: "#1E40AF" },
    stickyHeaderEnabled:   { type: Boolean, default: true },

    // ── NEW: Tenant Limits ────────────────────────────────────────────────────
    maxUsers: { type: Number, default: 10 },
    maxLeads: { type: Number, default: 1000 },

    // ── NEW: Audit — which Developer account created this company ─────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Developer",
      default: null,
    },

    // ── Brevo (email blast) credentials ──────────────────────────────────────
    brevoApiKey: {
      type: String,
      default: "",
      trim: true,
      select: false, // never returned in normal queries — must be explicitly selected
    },
    brevoSenderEmail: {
      type: String,
      default: "",
      trim: true,
    },
    brevoSenderName: {
      type: String,
      default: "",
      trim: true,
    },

    // ── Auto-template settings for new leads ─────────────────────────────────
    autoTemplate: {
      whatsapp: {
        enabled:      { type: Boolean, default: false },
        templateName: { type: String,  default: "skyup_greeting" },
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