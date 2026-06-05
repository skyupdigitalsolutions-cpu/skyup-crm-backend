// models/CompanyBenefit.js — NEW FILE
// Stores developer-granted benefits for a company.
// Benefits are free, one-off grants (not tied to payments) that layer on top
// of the plan + addon stack in entitlementService.
// A benefit can be a numeric resource boost or a boolean feature unlock.

const mongoose = require("mongoose");

// Benefit type enum — same categories as addon types so the same
// entitlementService merge logic can handle both.
const BENEFIT_TYPES = [
  // Resource benefits
  "extra_admin",
  "extra_users_5",
  "extra_leads_5000",
  "extra_website",
  "extra_meta_campaign",
  "extra_google_account",
  "storage_1gb",
  "storage_5gb",
  "storage_10gb",
  // Feature benefits
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
  // AI credit benefits
  "transcriptions_100",
  "transcriptions_500",
  "summaries_100",
  "summaries_500",
];

const companyBenefitSchema = new mongoose.Schema(
  {
    // Which company this benefit applies to
    companyId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
      index:    true,
    },

    // The type of benefit being granted
    benefitType: {
      type:     String,
      enum:     BENEFIT_TYPES,
      required: true,
    },

    // Quantity:
    //   • For resource benefits (e.g. extra_users_5): how many packs (1 pack = the pack's unit increment)
    //   • For feature unlocks (e.g. api_access): always 1
    quantity: {
      type:    Number,
      default: 1,
      min:     1,
    },

    // Who granted this benefit — always a Developer
    grantedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Developer",
      default: null,
    },

    // Validity window
    validFrom:  { type: Date, default: Date.now },
    validUntil: { type: Date, default: null },  // null = permanent

    // Whether the benefit is currently active
    // Set to false when expired or manually removed.
    active: {
      type:    Boolean,
      default: true,
      index:   true,
    },

    // Developer's note — reason for the grant, context, etc.
    notes: {
      type:    String,
      default: "",
      trim:    true,
    },
  },
  { timestamps: true }
);

// Compound index: fast lookup of active benefits for a company
companyBenefitSchema.index({ companyId: 1, active: 1 });
companyBenefitSchema.index({ companyId: 1, benefitType: 1, active: 1 });

const CompanyBenefit = mongoose.model("CompanyBenefit", companyBenefitSchema);

module.exports = CompanyBenefit;
module.exports.BENEFIT_TYPES = BENEFIT_TYPES;
