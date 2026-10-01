// models/CompanyCustomization.js
// ─────────────────────────────────────────────────────────────────────────────
// One document per company holding ONLY the parts of the CRM the company has
// customized. Anything not stored here falls back to config/customizationDefaults
// (= the CRM's original behaviour), so an empty/missing document is valid.
//
// Sections are Mixed on purpose: the shape is validated and normalised by
// services/customizationService.js before it is ever written, and keeping the
// storage schema-free means new customization options never need a migration.
// Always go through customizationService.updateSection() — never write here
// directly, or validation + cache invalidation will be skipped.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const Mixed = mongoose.Schema.Types.Mixed;

const companyCustomizationSchema = new mongoose.Schema(
  {
    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
      unique:   true,
      index:    true,
    },

    modules:      { type: Mixed, default: undefined },
    statuses:     { type: Mixed, default: undefined },
    outcomes:     { type: Mixed, default: undefined },
    temperatures: { type: Mixed, default: undefined },
    lists:        { type: Mixed, default: undefined },
    leadFields:   { type: Mixed, default: undefined },
    customFields: { type: Mixed, default: undefined },
    workflows:    { type: Mixed, default: undefined },
    permissions:  { type: Mixed, default: undefined },
    alerts:       { type: Mixed, default: undefined },
    general:      { type: Mixed, default: undefined },
    messaging:    { type: Mixed, default: undefined },
    dashboard:    { type: Mixed, default: undefined },

    // Bumped on every save — lets clients detect a stale editor.
    version: { type: Number, default: 0 },

    // Audit trail of who changed what (most recent first, capped).
    history: {
      type: [
        new mongoose.Schema(
          {
            section:   { type: String, required: true },
            action:    { type: String, default: "update" }, // update | reset
            actorId:   { type: mongoose.Schema.Types.ObjectId, default: null },
            actorRole: { type: String, default: "" },
            actorName: { type: String, default: "" },
            at:        { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model("CompanyCustomization", companyCustomizationSchema);
