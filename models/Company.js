// models/Company.js
const mongoose = require("mongoose");

const companySchema = mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    email:   { type: String, required: true, trim: true, unique: true },
    phone:   { type: String, trim: true },
    plan:    { type: String, enum: ["basic", "pro", "enterprise"], default: "basic" },
    isActive:{ type: Boolean, default: true },

    encryptionKeyHash: {
      type: String,
      default: null,
    },

    // ── Subscription & Expiry ─────────────────────────────────────────────────
    subscriptionExpiry: {
      type: Date,
      default: null,
    },
    subscriptionStatus: {
      type: String,
      enum: ["active", "expired", "trial", "cancelled"],
      default: "trial",
    },
    trialEndsAt: {
      type: Date,
      default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14-day free trial
    },

    // ── Data Privacy Settings ─────────────────────────────────────────────────
    dataEncryptionEnabled: {
      type: Boolean,
      default: false, // becomes true after client completes BIP39 setup
    },
  },
  { timestamps: true }
);

const Company = mongoose.model("Company", companySchema);
module.exports = Company;