// models/GoogleAnalyticsConfig.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-company Google Analytics 4 (GA4) connection.
// One document per company. Refresh token is stored encrypted (tokenCrypto).
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const googleAnalyticsConfigSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true, index: true },

    // OAuth
    refreshToken:      { type: String, default: null }, // encrypted at rest
    accessToken:       { type: String, default: null }, // encrypted at rest (short-lived cache)
    accessTokenExpiry: { type: Date,   default: null },
    scope:             { type: String, default: "" },
    connectedEmail:    { type: String, default: null }, // Google account email that authorized

    // Selected GA4 property
    propertyId:   { type: String, default: null }, // numeric GA4 property id, e.g. "123456789"
    propertyName: { type: String, default: null },

    connected:   { type: Boolean, default: false },
    connectedAt: { type: Date,    default: null },

    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("GoogleAnalyticsConfig", googleAnalyticsConfigSchema);