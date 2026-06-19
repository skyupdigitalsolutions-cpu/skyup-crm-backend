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
  // AI credit packs (one-time). Counted in MINUTES, matching the minute-based
  // transcription/summary billing. The legacy *_100 / *_500 packs are kept so
  // any existing purchases still validate; new packs are minute-denominated.
  "transcriptions_100",
  "transcriptions_500",
  "summaries_100",
  "summaries_500",
  "transcriptions_5000mins",
  "transcriptions_20000mins",
  "summaries_5000mins",
  "summaries_20000mins",
  // Combined transcription + summary minute packs (both pools topped up together)
  "transcription_summary_100mins",
  "transcription_summary_500mins",
  "transcription_summary_1000mins",
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

    // Price charged for this addon (0 = free/gifted, >0 = paid or custom-priced)
    price: {
      type:    Number,
      default: 0,
      min:     0,
    },

    // Currency code for the price
    currency: {
      type:    String,
      default: "INR",
      trim:    true,
      uppercase: true,
    },

    // Whether this addon instance should auto-renew when it expires.
    // Only meaningful for resource/feature addons with billingPeriod "monthly"/"yearly".
    // Credit packs (transcription/summary minutes) are NEVER auto-renewed — they
    // are consumed by usage and re-purchased by the customer when exhausted.
    autoRenew: {
      type:    Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Compound index: fast lookup of active addons for a company
companyAddonSchema.index({ companyId: 1, status: 1 });
companyAddonSchema.index({ companyId: 1, addonType: 1, status: 1 });

const CompanyAddon = mongoose.model("CompanyAddon", companyAddonSchema);

// ── Expiry policy ─────────────────────────────────────────────────────────────
// All one-time AI credit packs (transcription / summary minute packs) expire
// automatically this many days after purchase. After expiry the CompanyAddon is
// filtered out by getCompanyEntitlements (expiryDate <= now), so the granted
// minutes stop counting toward the company's monthly pool.
const CREDIT_PACK_EXPIRY_DAYS = 30;

// Add-on types that are one-time credit packs and should auto-expire.
const CREDIT_PACK_TYPES = new Set([
  "transcriptions_100",
  "transcriptions_500",
  "summaries_100",
  "summaries_500",
  "transcriptions_5000mins",
  "transcriptions_20000mins",
  "summaries_5000mins",
  "summaries_20000mins",
  // Combined packs — both transcription + summary minutes topped up together
  "transcription_summary_100mins",
  "transcription_summary_500mins",
  "transcription_summary_1000mins",
]);

/**
 * Compute the expiryDate for a newly purchased / granted add-on.
 *
 * Priority:
 *   1. Explicit durationMonths (developer override) → start + N months.
 *   2. Credit pack (one-time AI minutes)            → start + 30 days.
 *   3. billingPeriod monthly                        → start + 1 month.
 *   4. billingPeriod yearly                         → start + 1 year.
 *   5. Anything else (one_time feature/resource)    → null (never expires).
 *
 * @param {Object} opts
 * @param {string}  opts.addonType
 * @param {string} [opts.billingPeriod]
 * @param {number} [opts.durationMonths]
 * @param {Date}   [opts.startDate]
 * @returns {Date|null}
 */
function computeAddonExpiry({ addonType, billingPeriod, durationMonths, startDate } = {}) {
  const start = startDate ? new Date(startDate) : new Date();

  if (durationMonths) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + parseInt(durationMonths, 10));
    return d;
  }

  if (CREDIT_PACK_TYPES.has(addonType)) {
    const d = new Date(start);
    d.setDate(d.getDate() + CREDIT_PACK_EXPIRY_DAYS);
    return d;
  }

  if (billingPeriod === "monthly") {
    const d = new Date(start);
    d.setMonth(d.getMonth() + 1);
    return d;
  }
  if (billingPeriod === "yearly") {
    const d = new Date(start);
    d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  return null; // one_time feature/resource — no expiry
}

module.exports = CompanyAddon;
module.exports.ADDON_TYPES = ADDON_TYPES;
module.exports.CREDIT_PACK_TYPES = CREDIT_PACK_TYPES;
module.exports.CREDIT_PACK_EXPIRY_DAYS = CREDIT_PACK_EXPIRY_DAYS;
module.exports.computeAddonExpiry = computeAddonExpiry;