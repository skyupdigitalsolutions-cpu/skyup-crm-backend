// models/CompanyAddon.js — NEW FILE
// Stores purchased or developer-granted addons for a company.
// Each addon record carries a type, quantity, date range, and payment status.
// The entitlementService aggregates all active addons on top of the base plan.

const mongoose = require("mongoose");

// All addon type values — mirrors the spec exactly.
// Resource addons increase numeric limits; feature addons unlock boolean features.
const ADDON_TYPES = [
  // Resource addons
  "extra_admin",
  "extra_users_5",
  "extra_leads_5000",
  "extra_website",
  "extra_meta_campaign",
  "extra_google_account",
  "storage_1gb",
  "storage_5gb",
  "storage_10gb",
  // Feature addons
  "call_recording",
  "call_transcription",
  "ai_summary",
  "voice_bot",
  "whatsapp_automation",
  "api_access",
  "webhook_access",
  "white_label",
  "custom_domain",
  "custom_branding",
  // AI credit packs
  "transcriptions_100",
  "transcriptions_500",
  "summaries_100",
  "summaries_500",
];

const companyAddonSchema = new mongoose.Schema(
  {
    // Which company this addon belongs to
    companyId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
      index:    true,
    },

    // Type of addon — determines how entitlementService applies it
    addonType: {
      type:     String,
      enum:     ADDON_TYPES,
      required: true,
    },

    // Quantity — e.g. 2 × extra_users_5 = +10 users; 1 × storage_5gb = +5 GB
    quantity: {
      type:    Number,
      default: 1,
      min:     1,
    },

    // Validity window
    startDate:  { type: Date, required: true, default: Date.now },
    expiryDate: { type: Date, default: null },  // null = never expires

    // Lifecycle status
    status: {
      type:    String,
      enum:    ["active", "expired", "disabled"],
      default: "active",
      index:   true,
    },

    // Whether the addon was paid for or granted free by developer/superadmin
    paymentStatus: {
      type:    String,
      enum:    ["paid", "free", "pending"],
      default: "free",
    },

    // Actor who created this addon record (Developer or SuperAdmin ObjectId)
    createdBy: {
      type:    mongoose.Schema.Types.ObjectId,
      refPath: "createdByModel",
      default: null,
    },
    createdByModel: {
      type:    String,
      enum:    ["Developer", "Admin"],
      default: "Developer",
    },

    // Optional note from the creator (reason for grant, invoice ref, etc.)
    notes: {
      type:    String,
      default: "",
      trim:    true,
    },
  },
  { timestamps: true }
);

// Compound index: fast lookup of active addons for a company
companyAddonSchema.index({ companyId: 1, status: 1 });
companyAddonSchema.index({ companyId: 1, addonType: 1, status: 1 });

const CompanyAddon = mongoose.model("CompanyAddon", companyAddonSchema);

module.exports = CompanyAddon;
module.exports.ADDON_TYPES = ADDON_TYPES;
