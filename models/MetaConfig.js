const mongoose = require("mongoose");

const metaConfigSchema = new mongoose.Schema(
  {
    campaignName:    { type: String, required: true },
    pageId:          { type: String, required: true},
    pageAccessToken: { type: String, required: true },
    formIds:         [{ type: String }], // empty = accept all forms
    formId: {
  type: String,
  default: "",
  trim: true,
  // The specific Meta lead form ID this config handles.
  // Empty = catch-all for any form on this page.
},
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

    // ── Ad performance (Insights API) ─────────────────────────────────────────
    // To pull spend / CPM / CPC / CTR / reach for this campaign or ad set, set:
    //   adAccountId — the Meta ad account, formatted "act_1234567890"
    //   adsToken    — a token with the `ads_read` permission on that ad account
    //                 (a System User token is recommended; the leadgen
    //                  pageAccessToken usually does NOT have ads_read).
    // Optional adsetId/campaignId narrow insights to this exact ad set/campaign;
    // leave blank to report the whole ad account.
    adAccountId:     { type: String, default: "", trim: true },
    adsToken:        { type: String, default: "", trim: true },
    metaAdsetId:     { type: String, default: "", trim: true },
    metaCampaignId:  { type: String, default: "", trim: true },
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
metaConfigSchema.index(
  { pageId: 1, formId: 1 },
  { unique: true, name: "pageId_formId_unique" }
);

module.exports = mongoose.model("MetaConfig", metaConfigSchema);
