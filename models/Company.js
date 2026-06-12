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

      // NEW: per-field metadata for priced/time-limited limit overrides.
      // Keyed by the same numeric override key (e.g. "leads", "storageMB").
      // Each entry: { expiresAt: Date|null, price: Number, currency: String,
      //               grantedAt: Date }. The flat numeric value above remains
      //   the source of truth the entitlement engine reads; this map only
      //   carries the expiry + billing metadata so it can auto-revert and be
      //   shown in the UI. Stored as a free-form object map for flexibility.
      limitMeta: {
        type:    Map,
        of:      mongoose.Schema.Types.Mixed,
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

    // ── MSG91 Email (primary email blast, 5000/day limit → falls back to Brevo) ──
    msg91EmailApiKey: {
      type:    String,
      default: "",
      trim:    true,
      select:  false,
    },
    msg91EmailDomain:      { type: String, default: "", trim: true },
    msg91EmailSenderEmail: { type: String, default: "", trim: true },
    msg91EmailSenderName:  { type: String, default: "", trim: true },
    // Tracks how many emails sent via MSG91 today (resets at midnight UTC)
    msg91EmailDailyCount:  { type: Number, default: 0 },
    msg91EmailCountDate:   { type: String, default: "" }, // "YYYY-MM-DD" UTC


    // ── Telegram Notification Settings ────────────────────────────────────────
    // Campaign-only: only Meta / Google Ads / Website leads trigger notifications.
    telegramBotToken: { type: String, default: null, trim: true },
    telegramChatId:   { type: String, default: null, trim: true },
    telegramEnabled:  { type: Boolean, default: false },

    // ── Clock-in Location Restriction ─────────────────────────────────────────
    // If clockInLocationEnabled=true, employees must be within clockInRadiusMeters
    // of the company coordinates to clock in.
    clockInLocationEnabled: { type: Boolean, default: false },
    clockInLatitude:        { type: Number,  default: null },
    clockInLongitude:       { type: Number,  default: null },
    clockInRadiusMeters:    { type: Number,  default: 100 },

    // ── Client Meeting Location Tracking ─────────────────────────────────────
    // When an employee has clientMeetingPermission active, the app pings GPS
    // every meetingLocationIntervalMinutes and stores it in LiveLocation.
    // Employee must explicitly consent (grant location permission) on device.
    meetingLocationTrackingEnabled: { type: Boolean, default: false },
    meetingLocationIntervalMinutes: { type: Number,  default: 15, min: 5, max: 60 },

    // ── Device Call-Log Sync ─────────────────────────────────────────────────
    callLogSyncEnabled: { type: Boolean, default: true },

    // ── Company-wide Attendance Settings ──────────────────────────────────────
    // These apply to ALL employees in the company (not per-employee).
    attendanceConfig: {
      // Shift / working hours
      shiftStartHour:   { type: Number, default: 9,  min: 0, max: 23 },  // 9:00 AM
      shiftStartMinute: { type: Number, default: 0,  min: 0, max: 59 },
      shiftEndHour:     { type: Number, default: 18, min: 0, max: 23 },  // 6:00 PM
      shiftEndMinute:   { type: Number, default: 0,  min: 0, max: 59 },

      // Late threshold — clock-in after this is marked "Late"
      lateLoginHour:    { type: Number, default: 10, min: 0, max: 23 },  // 10:30 AM
      lateLoginMinute:  { type: Number, default: 30, min: 0, max: 59 },

      // Half-day threshold — working less than this many minutes = half day
      halfDayMinMinutes: { type: Number, default: 240 }, // 4 hours

      // Full-day threshold — working at least this many minutes = present
      fullDayMinMinutes: { type: Number, default: 480 }, // 8 hours

      // Weekly off days — array of weekday numbers (0=Sun, 1=Mon … 6=Sat)
      // Default: Sunday off
      weeklyOffDays: { type: [Number], default: [0] },

      // Specific holiday dates — array of "YYYY-MM-DD" strings
      holidays: [{
        date: { type: String, required: true },   // "2026-01-26"
        name: { type: String, default: "Holiday" }, // "Republic Day"
      }],
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