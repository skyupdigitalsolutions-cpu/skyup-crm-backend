const mongoose = require("mongoose");

const websiteConfigSchema = new mongoose.Schema(
  {
    sourceName:      { type: String, required: true },
    webhookSecret:   { type: String, required: true, unique: true },

    // ── Secret rotation support (A.5.17) ─────────────────────────────────────
    // Retired secrets that are still accepted during a rotation window. This
    // makes rotation ZERO-DOWNTIME: the webhook keeps accepting the old secret
    // while the GTM tag is updated, so no website lead is ever dropped.
    // Clear this array once the logs show the old secret is no longer in use.
    previousSecrets: { type: [String], default: [] },
    pageUrl:         { type: String, default: "" },
    isActive:        { type: Boolean, default: true },
    defaultStatus:   { type: String, default: "New" },
    defaultRemark:   { type: String, default: "Lead from Website" },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Company",
      required: true,
    },
    // Owning admin — stamped at creation. null = legacy/shared config visible to all admins.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Admin",
      default: null,
    },
    roundRobinIndex: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WebsiteConfig", websiteConfigSchema);