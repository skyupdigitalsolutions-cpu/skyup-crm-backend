const mongoose = require("mongoose");
const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");

// ─────────────────────────────────────────────────────────────────────────────
// LinkedInConfig — one document per connected LinkedIn Lead Gen Form/campaign,
// mirroring MetaConfig.js's shape and conventions exactly so the rest of the
// Campaigns page (round-robin, industry/service nurture tags, category
// grouping, active/paused toggle) works identically across both providers.
//
// UNLIKE Meta, LinkedIn requires LinkedIn's own Marketing Developer Platform
// approval + OAuth before any of this can go live — this config is what an
// admin fills in AFTER they've already completed that OAuth flow externally
// (e.g. via LinkedIn's own token generator / Postman / their own script) and
// has a real access token in hand. Same manual-token-paste pattern as Meta's
// "Page Access Token" field — this app never runs the OAuth dance itself.
// ─────────────────────────────────────────────────────────────────────────────
const linkedInConfigSchema = new mongoose.Schema(
  {
    campaignName: { type: String, required: true },

    // The LinkedIn organization this form belongs to, e.g. "urn:li:organization:12345678"
    organizationUrn: { type: String, required: true, trim: true },

    // OAuth access token with r_marketing_leadgen_automation scope.
    // LinkedIn access tokens expire (~60 days) — tokenExpiresAt lets the UI
    // show a "reconnect" badge before it silently stops working.
    accessToken:    { type: String, required: true },
    refreshToken:   { type: String, default: "" },
    tokenExpiresAt: { type: Date, default: null },

    // HMAC secret LinkedIn issues when you register a webhook — used to
    // validate the challenge-response handshake and verify every inbound
    // notification is genuinely from LinkedIn, not a forged request.
    webhookSecret: { type: String, required: true },

    // Which Lead Sync API leadType this config listens for.
    //   SPONSORED — ad-driven Lead Gen Forms (the common case)
    //   COMPANY   — organic company page leads
    //   EVENT     — LinkedIn Events lead capture
    leadType: {
      type: String,
      enum: ["SPONSORED", "COMPANY", "EVENT"],
      default: "SPONSORED",
    },

    // Specific Lead Gen Form URNs this config accepts, e.g.
    // "urn:li:leadGenForm:1234567". Empty = accept all forms on this
    // organization for the given leadType — same "empty = catch-all"
    // convention as MetaConfig.formIds.
    formUrns: [{ type: String, trim: true }],

    isActive: { type: Boolean, default: true },

    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
    },

    // Round-robin — identical mechanism to MetaConfig: no single assignee,
    // leads rotate across all company users via $inc + modulo, same as
    // utils/metaHelper.js's getNextAssignedUser().
    roundRobinIndex: { type: Number, default: 0 },

    defaultStatus: { type: String, default: "New" },
    defaultRemark: { type: String, default: "Lead from LinkedIn Campaign" },

    // Admin who created this config — scopes round-robin the same way
    // MetaConfig.createdBy does, so LinkedIn leads only go to employees
    // under that admin.
    createdBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Admin",
      default: null,
    },

    // ── Lead Nurture — industry + service tags ──────────────────────────────
    // Same convention and validation as MetaConfig: set here so every lead
    // from this campaign is auto-tagged for nurture template resolution.
    // Validated against utils/templateNameResolver.js's canonical lists at
    // the controller level (see linkedinConfigController.js) — an
    // unrecognised value is rejected, never silently saved, mirroring the
    // exact fix applied to metaConfigController.js earlier.
    industry: { type: String, default: "", trim: true },
    service:  { type: String, default: "", trim: true },

    // ── Campaign grouping (same UI concept as Meta's ad-set/parent-campaign
    // fields, renamed to match LinkedIn's own terminology) ──────────────────
    // LinkedIn's own hierarchy: Campaign Group > Campaign > Lead Gen Form.
    campaignGroupName: { type: String, default: "", trim: true }, // groups related campaigns, like Meta's parentCampaignName
    adCampaignName:    { type: String, default: "", trim: true }, // the specific LinkedIn ad campaign, like Meta's adSetName

    category: { type: String, default: "", trim: true },

    // ── LinkedIn-side live status (mirrors MetaConfig's metaActive/
    // pausedByMeta pattern) — populated by a future auto-sync job if one is
    // built; harmless/unused until then.
    linkedInActive: { type: Boolean, default: null },
    pausedByLinkedIn: { type: Boolean, default: false },
  },
  { timestamps: true },
);

linkedInConfigSchema.index(
  { organizationUrn: 1, formUrns: 1 },
  { name: "org_formUrns_lookup" }
);

linkedInConfigSchema.plugin(encryptedFieldsPlugin, {
  fields: ["accessToken", "refreshToken", "webhookSecret"],
});

module.exports = mongoose.model("LinkedInConfig", linkedInConfigSchema);
