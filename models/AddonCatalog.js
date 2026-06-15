// models/AddonCatalog.js — NEW FILE
// Developer-managed catalogue of purchasable add-ons.
//
// This is the SINGLE SOURCE OF TRUTH for add-on pricing and visibility.
// The developer sets, per add-on type:
//   • price + currency + billing period
//   • whether it is publicly buyable (isPublic)
//   • which plans it shows up for (visiblePlans — empty array = all plans)
//
// The upgrade page reads the PUBLIC subset (GET /subscription/addons) and
// renders priced cards. On purchase, addonPaymentController verifies the
// Razorpay signature and creates a CompanyAddon — which the existing
// entitlementService already aggregates into the company's live entitlements.
//
// addonType values MUST stay in sync with CompanyAddon.ADDON_TYPES and the
// RESOURCE_ADDON_DELTA / FEATURE_ADDON_FLAG maps in entitlementService.js.

const mongoose = require("mongoose");
const { ADDON_TYPES } = require("./CompanyAddon");

const addonCatalogSchema = new mongoose.Schema(
  {
    // Add-on identifier — matches CompanyAddon.addonType exactly.
    addonType: {
      type:     String,
      enum:     ADDON_TYPES,
      required: true,
      unique:   true,
      index:    true,
    },

    // Customer-facing display name (e.g. "5 Extra Users")
    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    // Short description shown under the name on the card
    description: {
      type:    String,
      default: "",
      trim:    true,
    },

    // "resource" (raises a numeric limit) | "feature" (unlocks a flag) | "credit" (AI pack)
    category: {
      type:    String,
      enum:    ["resource", "feature", "credit"],
      default: "feature",
    },

    // Price the customer pays per unit (per billing period).
    price: {
      type:    Number,
      default: 0,
      min:     0,
    },

    currency: {
      type:      String,
      default:   "INR",
      uppercase: true,
      trim:      true,
    },

    // How the price recurs. "monthly"/"yearly" set the CompanyAddon expiry;
    // "one_time" creates a non-expiring addon (e.g. a one-off AI credit pack).
    billingPeriod: {
      type:    String,
      enum:    ["monthly", "yearly", "one_time"],
      default: "monthly",
    },

    // Whether customers may purchase this on the upgrade page.
    // false = exists for developer grant only, never shown publicly.
    isPublic: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    // Which plan keys this add-on is offered for. EMPTY = all plans.
    // e.g. ["pro", "enterprise"] hides it from trial/basic customers.
    visiblePlans: {
      type:    [String],
      default: [],
    },

    // Max quantity a customer may buy in one purchase (1 = single toggle).
    maxQuantity: {
      type:    Number,
      default: 1,
      min:     1,
    },

    // Display order on the upgrade page (lower = first).
    sortOrder: {
      type:    Number,
      default: 0,
    },

    // Soft on/off without deleting the catalogue row.
    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Helper: is this addon offered to a given plan key?
addonCatalogSchema.methods.isVisibleForPlan = function (planKey) {
  if (!this.isPublic || !this.isActive) return false;
  if (!Array.isArray(this.visiblePlans) || this.visiblePlans.length === 0) return true;
  return this.visiblePlans.includes(planKey);
};

const AddonCatalog = mongoose.model("AddonCatalog", addonCatalogSchema);

module.exports = AddonCatalog;
