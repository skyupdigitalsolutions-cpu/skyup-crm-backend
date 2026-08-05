const mongoose = require("mongoose");
const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");

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
    // Admin who created / owns this config — used to scope round-robin
    // assignment so Meta leads only go to employees under that admin.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    // ── Campaign category (user-defined) ──────────────────────────────────────
    // Free-form label to group campaigns in the Performance Marketing Dashboard.
    // Examples: "Real Estate", "Education", "Healthcare", "Product Launch", etc.
    category: {
      type: String,
      default: "",
      trim: true,
    },

    // ── Meta-side live status (auto-synced) ───────────────────────────────────
    // Mirrors the real ACTIVE/PAUSED/ARCHIVED state of the ad set + lead form on
    // Meta. The auto-sync job updates these so the CRM shows a config as inactive
    // the moment its ad set / form is paused or archived on Meta.
    //   metaFormStatus   raw lead-form status  (ACTIVE / ARCHIVED / DELETED / DRAFT / PAUSED)
    //   metaAdsetStatus  raw ad-set effective_status (ACTIVE / PAUSED / ADSET_PAUSED / …)
    //   metaActive       derived: true only when BOTH form and ad set are active on Meta
    //   pausedByMeta      true when the CRM auto-paused this config to match Meta
    //                     (lets sync auto-reactivate it if Meta turns it back on,
    //                      without ever overriding an admin's own manual pause)
    //   metaStatusSyncedAt  last time the status was read from Meta
    metaFormStatus:     { type: String, default: "" },
    metaAdsetStatus:    { type: String, default: "" },
    metaCampaignStatus: { type: String, default: "" },
    metaActive:         { type: Boolean, default: true },
    pausedByMeta:       { type: Boolean, default: false },
    metaStatusSyncedAt: { type: Date, default: null },

    // ── Conversions API (CAPI) — send-back, NOT pull ─────────────────────────
    // Lets the CRM tell Meta which leads actually converted (status changes),
    // so ad delivery optimizes toward real customers instead of raw form
    // submissions. Company-gated overall via
    // Company.devOverrides.featureToggles.metaConversionSync — this pixelId/
    // token pair is the per-campaign credential the sync uses once that
    // company-wide toggle is on. Both blank = CAPI sync silently skipped for
    // leads from this config (see services/metaConversionService.js).
    //   pixelId         — the Meta Pixel ID associated with this ad account
    //                      (Events Manager → Data Sources → your Pixel).
    //   capiAccessToken — a Conversions API access token for that pixel
    //                      (Events Manager → Settings → Conversions API →
    //                       Generate Access Token). Distinct from
    //                      pageAccessToken above — CAPI tokens are
    //                      pixel-scoped, not page-scoped.
    pixelId:         { type: String, default: "", trim: true },
    capiAccessToken: { type: String, default: "", trim: true },
  },
  { timestamps: true },
);
metaConfigSchema.index(
  { pageId: 1, formId: 1 },
  { unique: true, name: "pageId_formId_unique" }
);

metaConfigSchema.plugin(encryptedFieldsPlugin, {
  fields: ["pageAccessToken", "appSecret", "verifyToken", "capiAccessToken"],
});

module.exports = mongoose.model("MetaConfig", metaConfigSchema);