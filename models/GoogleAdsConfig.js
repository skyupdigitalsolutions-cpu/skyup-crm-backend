const mongoose = require("mongoose");

const googleAdsConfigSchema = new mongoose.Schema(
  {
    campaignName:  { type: String, required: true },
    googleKey:     { type: String, required: true, unique: true },
    campaignId:    { type: String, default: "" },
    formId:        { type: String, default: "" },
    isActive:      { type: Boolean, default: true },
    defaultStatus: { type: String, default: "New" },
    defaultRemark: { type: String, default: "Lead from Google Ads" },

    // ── FIX: Added lead counters (same pattern as MetaConfig) ────────────────
    // These were missing — so the card always showed "—" for leads.
    leads:    { type: Number, default: 0 },
    converted:{ type: Number, default: 0 },
    sent:     { type: Number, default: 0 },
    cost:     { type: Number, default: 0 },

    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },

    roundRobinIndex: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("GoogleAdsConfig", googleAdsConfigSchema);
