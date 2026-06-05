// models/EntitlementAuditLog.js — NEW FILE
// Immutable audit trail for all entitlement-related actions:
// plan changes, addon grants/disables, benefit grants, dev overrides,
// AI credit additions, subscription status changes, etc.
//
// Records are written by controllers/services using logAudit() helper
// exported from entitlementService.  Records are NEVER updated or deleted.

const mongoose = require("mongoose");

const entitlementAuditLogSchema = new mongoose.Schema(
  {
    // The company affected
    companyId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
      index:    true,
    },

    // Who performed the action (Developer _id or Admin _id)
    actorId: {
      type:    mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // Role of the actor for display purposes
    actorRole: {
      type:    String,
      enum:    ["developer", "super_admin", "system"],
      default: "system",
    },

    // Machine-readable action identifier — used for filtering in audit log UI
    // Examples: "plan_changed", "addon_granted", "addon_renewed", "addon_disabled",
    //           "benefit_granted", "benefit_extended", "benefit_removed",
    //           "dev_override_applied", "ai_credits_added",
    //           "subscription_status_changed", "trial_extended"
    action: {
      type:     String,
      required: true,
      trim:     true,
    },

    // The specific field or resource that changed (optional)
    // e.g. "plan", "subscriptionStatus", "addonType", "benefitType", "devOverrides.users"
    field: {
      type:    String,
      default: "",
      trim:    true,
    },

    // Previous value before the change (can be any type)
    oldValue: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
    },

    // New value after the change
    newValue: {
      type:    mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Human-readable reason / note provided by the actor
    reason: {
      type:    String,
      default: "",
      trim:    true,
    },
  },
  {
    // createdAt is the audit timestamp — no updatedAt needed (immutable records)
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Indexes for the audit log query patterns in CompanyDetails page
entitlementAuditLogSchema.index({ companyId: 1, createdAt: -1 });
entitlementAuditLogSchema.index({ companyId: 1, action: 1, createdAt: -1 });

const EntitlementAuditLog = mongoose.model("EntitlementAuditLog", entitlementAuditLogSchema);
module.exports = EntitlementAuditLog;
