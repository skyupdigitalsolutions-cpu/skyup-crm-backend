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

    // ── Ad performance metrics (manually entered) ─────────────────────────────
    // Google Ads has no lead-webhook-accessible metrics API here, so spend /
    // impressions / clicks are entered per campaign (copy them from the Google
    // Ads dashboard). CPC, CTR and CPM are DERIVED from these in the Google Ads
    // Performance report — do not store the derived values.
    impressions: { type: Number, default: 0 },
    clicks:      { type: Number, default: 0 },

    // Average revenue per won customer for this campaign. Revenue is derived as
    // (customers won) × avgDealValue — the CRM has no per-lead deal value, so
    // this per-campaign average is how ROAS / ROI / CPA / revenue are computed.
    avgDealValue: { type: Number, default: 0 },

    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
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

module.exports = mongoose.model("GoogleAdsConfig", googleAdsConfigSchema);
