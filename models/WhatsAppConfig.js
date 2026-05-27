const mongoose = require("mongoose");

// Stores the WhatsApp Business API credentials for each company
// One company = one WhatsApp Business number
// Supports both MSG91 and Meta Cloud API as providers
const whatsAppConfigSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      unique: true, // one WA config per company
    },

    // ── Provider selection ────────────────────────────────────────────────────
    // "msg91" = MSG91 WhatsApp API  (env: MSG91_AUTH_KEY + MSG91_INTEGRATED_NUMBER)
    // "meta"  = Meta WhatsApp Cloud API (phoneNumberId + accessToken below)
    provider: {
      type: String,
      enum: ["msg91", "meta"],
      default: "msg91",
    },

    // ── MSG91 fields (provider === "msg91") ───────────────────────────────────
    // Falls back to process.env values if blank — so .env is the single source of truth
    msg91AuthKey: {
      type: String,
      default: "",
      trim: true,
      // Example: "447171TxxxXXXX67f2b4e5"
    },

    msg91IntegratedNumber: {
      type: String,
      default: "",
      trim: true,
      // Example: "919876543210"  (country code + number, no +)
    },

    // ── MSG91 WhatsApp namespace (from MSG91 / Meta Business dashboard) ───────
    // Each company has a unique namespace tied to their WABA account.
    // Previously this was hardcoded in the controller — Bug #4 fix.
    msg91Namespace: {
      type: String,
      default: "",
      trim: true,
    },

    // URL of the brochure/document attached as a header in MSG91 templates.
    // Leave empty if the template has no document header.
    msg91BrochureUrl: {
      type: String,
      default: "",
      trim: true,
    },

    // ── Meta Cloud API fields (provider === "meta") ───────────────────────────
    phoneNumberId: {
      type: String,
      default: "",
      trim: true,
    },

    accessToken: {
      type: String,
      default: "",
      trim: true,
    },

    businessAccountId: {
      type: String,
      default: "",
      trim: true,
    },

    verifyToken: {
      type: String,
      default: "",
      trim: true,
    },

    graphApiVersion: {
      type: String,
      default: "v21.0",
    },

    // ── Common ────────────────────────────────────────────────────────────────
    phoneNumber: {
      type: String,
      default: "",
      trim: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WhatsAppConfig", whatsAppConfigSchema);