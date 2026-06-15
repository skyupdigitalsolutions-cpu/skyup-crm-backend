// models/PlanConfig.js — UPDATED
// Added: maxWebsites, maxMetaCampaigns, maxGoogleAccounts, maxStorageMB,
//        transcriptionsPerMonth, summariesPerMonth, voiceBotPerMonth,
//        recordingEnabled, dataRetentionDays
// All existing fields are UNCHANGED.

const mongoose = require("mongoose");

const featureSchema = new mongoose.Schema(
  {
    key:     { type: String, required: true, trim: true },
    label:   { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: false },
  },
  { _id: false }
);

const planConfigSchema = new mongoose.Schema(
  {
    // Slug used as the plan identifier — e.g. "trial", "basic", "pro", "enterprise"
    planKey: {
      type:      String,
      required:  true,
      unique:    true,
      trim:      true,
      lowercase: true,
    },

    // Display name shown to customers
    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    // Optional tagline / description shown on upgrade page
    description: {
      type:    String,
      default: "",
      trim:    true,
    },

    // Accent colour for plan badges / cards (hex string)
    color: {
      type:    String,
      default: "#6B7280",
      trim:    true,
    },

    // Pricing
    price: {
      monthly: { type: Number, default: 0, min: 0 },
      yearly:  { type: Number, default: 0, min: 0 },
    },

    // ── Tenant Limits ─────────────────────────────────────────────────────────
    maxUsers:  { type: Number, default: 5,    min: 1 },
    maxAdmins: { type: Number, default: 1,    min: 1 },
    maxLeads:  { type: Number, default: 1000, min: 0 },  // 0 = no limit

    // NEW: Extended resource limits
    maxWebsites:          { type: Number, default: 1,   min: 0 },
    maxMetaCampaigns:     { type: Number, default: 1,   min: 0 },
    maxGoogleAccounts:    { type: Number, default: 1,   min: 0 },
    maxStorageMB:         { type: Number, default: 100, min: 0 },

    // ── AI / Transcription Monthly Limits ─────────────────────────────────────
    // 0 = feature not available on this plan
    transcriptionsPerMonth: { type: Number, default: 0, min: 0 },
    summariesPerMonth:      { type: Number, default: 0, min: 0 },
    voiceBotPerMonth:       { type: Number, default: 0, min: 0 },

    // ── Feature Flags ─────────────────────────────────────────────────────────
    recordingEnabled:    { type: Boolean, default: false },
    dataRetentionDays:   { type: Number,  default: 15, min: 1 },

    // Feature list — same keys as DEFAULT_PLAN_FEATURES in subscriptionController
    features: { type: [featureSchema], default: [] },

    // Ordering on upgrade/pricing pages (lower = first)
    sortOrder: { type: Number, default: 0 },

    // Whether this plan is visible/selectable by customers
    isActive: { type: Boolean, default: true },

    // Custom "Contact us" tier — no fixed price, not purchasable via Razorpay.
    custom: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const PlanConfig = mongoose.model("PlanConfig", planConfigSchema);
module.exports = PlanConfig;
