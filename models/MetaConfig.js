const mongoose = require("mongoose");

const metaConfigSchema = new mongoose.Schema(
  {
    campaignName:    { type: String, required: true },
    pageId:          { type: String, required: true, unique: true },
    pageAccessToken: { type: String, required: true },
    formIds:         [{ type: String }], // empty = accept all forms
    isActive:        { type: Boolean, default: true },

    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
    },

    // Round-robin: no single assignedUser — leads rotate across all company users
    roundRobinIndex: {
      type:    Number,
      default: 0, // pointer to the next user slot
    },

    defaultStatus:   { type: String, default: "New" },
    defaultRemark:   { type: String, default: "Lead from Meta Campaign" },
    graphApiVersion: { type: String, default: "v21.0" }, // per-campaign API version
    appSecret:       { type: String, default: "" },       // per-campaign App Secret for signature verification
    verifyToken:     { type: String, default: "" },       // per-campaign verify token

    // ── Ad Set differentiation ────────────────────────────────────────────────
    // When a single Meta campaign has multiple ad sets, configure one MetaConfig
    // per ad set and set these fields to visually group them on the Campaigns page.
    adSetName: {
      type: String,
      default: "",
      trim: true,
      // e.g. "Retargeting", "Lookalike - Mumbai", "Cold - Age 25-35"
    },
    parentCampaignName: {
      type: String,
      default: "",
      trim: true,
      // e.g. "Summer Sale 2025" — used to group ad sets under the same campaign header
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("MetaConfig", metaConfigSchema);