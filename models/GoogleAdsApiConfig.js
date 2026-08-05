// models/GoogleAdsApiConfig.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-company Google Ads API connection (LIVE metrics via the Google Ads API).
// Separate from GoogleAdsConfig (which is the per-campaign lead-webhook config).
//
// One document per company. Refresh token + OAuth client secret are stored
// encrypted (tokenCrypto). OAuth app credentials can be set per company from the
// CRM UI; if absent they fall back to the server-wide GOOGLE_OAUTH_* env vars.
// The developer token is app-level (server env), not stored here.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");

const googleAdsApiConfigSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true, index: true },

    // OAuth APP credentials (optional per-company override of env vars)
    oauthClientId:     { type: String, default: null },
    oauthClientSecret: { type: String, default: null }, // encrypted at rest
    oauthRedirectUri:  { type: String, default: null },

    // Google Ads API developer token (per company, encrypted). Falls back to the
    // server env GOOGLE_ADS_DEVELOPER_TOKEN only if this is not set.
    developerToken:    { type: String, default: null }, // encrypted at rest

    // OAuth tokens
    refreshToken:      { type: String, default: null }, // encrypted at rest
    accessToken:       { type: String, default: null }, // encrypted at rest (cache)
    accessTokenExpiry: { type: Date,   default: null },
    scope:             { type: String, default: "" },
    connectedEmail:    { type: String, default: null },

    // Selected Google Ads account
    customerId:        { type: String, default: null }, // digits only, no dashes
    customerName:      { type: String, default: null },
    loginCustomerId:   { type: String, default: null }, // manager id (optional)

    connected:   { type: Boolean, default: false },
    connectedAt: { type: Date,    default: null },
    lastSyncedAt:{ type: Date,    default: null },

    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

googleAdsApiConfigSchema.plugin(encryptedFieldsPlugin, {
  fields: ["oauthClientSecret", "developerToken", "refreshToken", "accessToken"],
});

module.exports = mongoose.model("GoogleAdsApiConfig", googleAdsApiConfigSchema);