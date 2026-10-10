// models/MarketingSettings.js
// Per-company configuration for the Performance Marketing dashboard:
// creative-rating minimum-data thresholds, fatigue rules, lead-response SLAs
// and optional targets used for "vs target" comparisons.
const mongoose = require("mongoose");

const marketingSettingsSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true, index: true },

    // Don't rate an ad until it has at least this much data ("Learning / Insufficient data").
    creativeMinImpressions: { type: Number, default: 1000 },
    creativeMinSpend:       { type: Number, default: 500 },
    creativeMinClicks:      { type: Number, default: 20 },
    creativeMinLeads:       { type: Number, default: 3 },

    // Creative fatigue: frequency threshold + relative decline between range halves.
    fatigueFrequency:       { type: Number, default: 3 },
    fatigueCtrDropPct:      { type: Number, default: 20 },
    fatigueCpcRisePct:      { type: Number, default: 20 },

    // Lead response SLAs (minutes).
    slaFirstContactMinutes: { type: Number, default: 60 },
    proposalStaleDays:      { type: Number, default: 5 },

    // Optional targets (0 = not set → compare against history only).
    targetCpl:  { type: Number, default: 0 },
    targetCpql: { type: Number, default: 0 },
    targetCac:  { type: Number, default: 0 },
    targetRoas: { type: Number, default: 0 },

    // Fallback deal value used to ESTIMATE revenue for won leads that have no
    // dealValue recorded (shown as "estimated" everywhere). 0 = no estimate.
    defaultDealValue: { type: Number, default: 0 },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MarketingSettings", marketingSettingsSchema);
