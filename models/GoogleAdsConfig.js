const mongoose = require("mongoose");

const googleAdsConfigSchema = new mongoose.Schema(
  {
    campaignName:   { type: String, required: true },
    googleKey:      { type: String, required: true, unique: true }, // webhook secret key from Google Ads
    campaignId:     { type: String, default: "" },   // optional filter by campaign
    formId:         { type: String, default: "" },   // optional filter by form
    isActive:       { type: Boolean, default: true },
    defaultStatus:  { type: String, default: "New" },
    defaultRemark:  { type: String, default: "Lead from Google Ads" },

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