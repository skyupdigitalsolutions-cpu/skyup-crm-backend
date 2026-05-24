// models/PlanConfig.js
// Stores developer-configured plan definitions in the database.
// Falls back to DEFAULT_PLAN_FEATURES in subscriptionController if no DB records exist.
const mongoose = require('mongoose');

const featureSchema = new mongoose.Schema(
  {
    key:     { type: String, required: true, trim: true },
    label:   { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: false },
  },
  { _id: false }
);

const planConfigSchema = new mongoose.Schema(
  {
    // Slug used as the plan identifier (e.g. "basic", "pro", "enterprise")
    planKey: {
      type:     String,
      required: true,
      unique:   true,
      trim:     true,
      lowercase: true,
    },

    // Display name shown to customers
    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    // Optional tagline / description shown on upgrade page
    description: {
      type:    String,
      default: '',
      trim:    true,
    },

    // Accent colour for plan badges / cards (hex string)
    color: {
      type:    String,
      default: '#6B7280',
      trim:    true,
    },

    // Pricing
    price: {
      monthly: { type: Number, default: 0, min: 0 },
      yearly:  { type: Number, default: 0, min: 0 },
    },

    // Tenant limits
    maxUsers:  { type: Number, default: 5,    min: 1 },
    maxAdmins: { type: Number, default: 2,    min: 1 },
    maxLeads:  { type: Number, default: 1000, min: 0 },  // 0 = no limit

    // Feature list — same keys as DEFAULT_PLAN_FEATURES
    features: { type: [featureSchema], default: [] },

    // Ordering on upgrade/pricing pages (lower = first)
    sortOrder: { type: Number, default: 0 },

    // Whether this plan is visible/selectable by customers
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const PlanConfig = mongoose.model('PlanConfig', planConfigSchema);
module.exports = PlanConfig;