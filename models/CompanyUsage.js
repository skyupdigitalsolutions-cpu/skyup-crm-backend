// models/CompanyUsage.js — NEW FILE
// Tracks per-company AI/feature usage for the current calendar month.
// One document per company per month.  The usageResetJob creates a fresh
// document on the 1st of every month.
//
// Note: demo credits are stored on CompanyAddon (addonType: "transcriptions_*"
// / "summaries_*" with paymentStatus: "free") and are NOT reset monthly.

const mongoose = require("mongoose");

const companyUsageSchema = new mongoose.Schema(
  {
    // Company reference
    companyId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
    },

    // ISO month string — "YYYY-MM" — e.g. "2025-06"
    // Combined with companyId as a unique key (see index below).
    month: {
      type:     String,
      required: true,
      match:    /^\d{4}-\d{2}$/,
    },

    // ── Monthly counters ──────────────────────────────────────────────────────
    // Each counter is incremented by consumeUsage() in entitlementService.

    // Mobile call recordings consumed this month
    recordingsUsed: { type: Number, default: 0, min: 0 },

    // AI transcriptions consumed this month
    transcriptionsUsed: { type: Number, default: 0, min: 0 },

    // AI call summaries consumed this month
    summariesUsed: { type: Number, default: 0, min: 0 },

    // Voice-bot interactions consumed this month
    voiceBotUsed: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// Unique compound index — one document per company per month.
// Also used as the fast lookup key in entitlementService.
companyUsageSchema.index({ companyId: 1, month: 1 }, { unique: true });

const CompanyUsage = mongoose.model("CompanyUsage", companyUsageSchema);
module.exports = CompanyUsage;
