// models/Company.js — UPDATED
// Adds: subscriptionStatus "suspended"|"paused", plan "trial", maxAdmins,
//       maxWebsites, maxMetaCampaigns, maxGoogleAccounts, maxStorage,
//       devOverrides, aiProviderMode, customerOpenAiKey, customerGeminiKey,
//       demoCreditGranted
// All existing fields are UNCHANGED.

const mongoose = require("mongoose");

const companySchema = mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    email:   { type: String, required: true, trim: true, unique: true },
    phone:   { type: String, trim: true },

    // ── Plan — extended to include "trial" ────────────────────────────────────
    plan: {
      type:    String,
      enum:    ["trial", "basic", "pro", "enterprise"],
      default: "trial",
    },

    isActive: { type: Boolean, default: true },

    encryptionKeyHash: {
      type:    String,
      default: null,
    },

    // ── Subscription & Expiry ─────────────────────────────────────────────────
    subscriptionExpiry: {
      type:    Date,
      default: null,
    },

    // Extended enum — adds "suspended" and "paused"
    subscriptionStatus: {
      type:    String,
      enum:    ["active", "expired", "trial", "cancelled", "suspended", "paused"],
      default: "trial",
    },

    trialEndsAt: {
      type:    Date,
      default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14-day free trial
    },

    // ── Data Privacy Settings ─────────────────────────────────────────────────
    dataEncryptionEnabled: {
      type:    Boolean,
      default: false,
    },

    // ── FIX 4D: Atomic round-robin index ─────────────────────────────────────
    roundRobinIndex: {
      type:    Number,
      default: 0,
    },

    // ── Company Branding (set by SuperAdmin) ──────────────────────────────────
    brandName:    { type: String, default: "", trim: true },
    brandLogoUrl: { type: String, default: "", trim: true },

    // ── Header Bar Branding (set by Developer per-company) ────────────────────
    headerName:    { type: String, default: "", trim: true },
    headerLogoUrl: { type: String, default: "", trim: true },

    // ── Extended Branding & Media ─────────────────────────────────────────────
    logo:    { type: String, default: "" },
    favicon: { type: String, default: "" },
    website: { type: String, default: "" },
    address: { type: String, default: "" },

    // ── Theme Colors ──────────────────────────────────────────────────────────
    companyPrimaryColor:   { type: String, default: "#2563EB" },
    companySecondaryColor: { type: String, default: "#1E40AF" },
    stickyHeaderEnabled:   { type: Boolean, default: true },

    // ── Tenant Limits (base — may be overridden by addons/benefits/devOverrides) ──
    maxUsers:  { type: Number, default: 10 },
    maxLeads:  { type: Number, default: 1000 },

    // ── NEW: Extended Tenant Limits ───────────────────────────────────────────
    maxAdmins:          { type: Number, default: 1 },
    maxWebsites:        { type: Number, default: 1 },
    maxMetaCampaigns:   { type: Number, default: 1 },
    maxGoogleAccounts:  { type: Number, default: 1 },
    maxStorage:         { type: Number, default: 100 }, // MB

    // ── NEW: Developer Override Block ─────────────────────────────────────────
    // Highest-priority override — set by developer per-company.
    // Numeric keys override plan+addon+benefit limits.
    // featureToggles is a Map<String, Boolean> keyed by feature key.
    devOverrides: {
      admins:         { type: Number, default: null },
      users:          { type: Number, default: null },
      leads:          { type: Number, default: null },
      websites:       { type: Number, default: null },
      metaCampaigns:  { type: Number, default: null },
      googleAccounts: { type: Number, default: null },
      storageMB:      { type: Number, default: null },

      // NEW: per-company AI / feature LIMIT overrides (null = inherit from plan+addons).
      // These let the developer set an ABSOLUTE monthly cap for a single company,
      // independent of the plan, without touching any other company.
      transcriptionsLimit: { type: Number,  default: null },
      summariesLimit:      { type: Number,  default: null },
      voiceBotLimit:       { type: Number,  default: null },
      recordingEnabled:    { type: Boolean, default: null },

      featureToggles: {
        type: Map,
        of:   Boolean,
        default: {},
      },
    },

    // ── NEW: AI Provider Mode ─────────────────────────────────────────────────
    aiProviderMode: {
      type:    String,
      enum:    ["platform_ai", "customer_openai", "customer_gemini"],
      default: "platform_ai",
    },

    // Customer-supplied keys — never returned in normal queries
    customerOpenAiKey: { type: String, select: false },
    customerGeminiKey: { type: String, select: false },

    // ── NEW: Demo Credit Grant Flag ───────────────────────────────────────────
    // Set to true after first-activation demo credits have been granted.
    // Prevents double-granting on re-activations.
    demoCreditGranted: { type: Boolean, default: false },

    // ── Plan feature overrides (set by Developer per-company) ─────────────────
    planFeatures: {
      type:    [{ key: String, enabled: Boolean }],
      default: [],
    },

    // ── Audit — which Developer account created this company ──────────────────
    createdBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Developer",
      default: null,
    },

    // ── Brevo (email blast) credentials ──────────────────────────────────────
    brevoApiKey: {
      type:    String,
      default: "",
      trim:    true,
      select:  false,
    },
    brevoSenderEmail: { type: String, default: "", trim: true },
    brevoSenderName:  { type: String, default: "", trim: true },


    // ── Telegram Notification Settings ────────────────────────────────────────
    // Campaign-only: only Meta / Google Ads / Website leads trigger notifications.
    telegramBotToken: { type: String, default: null, trim: true, select: false },
    telegramChatId:   { type: String, default: null, trim: true },
    telegramEnabled:  { type: Boolean, default: false },

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
        bodyTemplate: {
          type:    String,
          default: "<p>Hi {{name}},</p><p>Thank you for your interest. Our team will reach out to you shortly.</p><p>Regards,<br/>The Team</p>",
        },
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
