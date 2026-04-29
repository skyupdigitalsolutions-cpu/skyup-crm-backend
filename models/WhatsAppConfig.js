const mongoose = require("mongoose");

// Stores the WhatsApp Business API credentials for each company
// One company = one WhatsApp Business number
const whatsAppConfigSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      unique: true, // one WA config per company
    },

    // From Meta Developer Console → WhatsApp → API Setup
    phoneNumberId: {
      type: String,
      required: true,
      trim: true,
      // Example: "123456789012345"
    },

    // System User Access Token (permanent) — generated in Meta Business Manager
    // Settings → Business Settings → System Users → Generate Token
    accessToken: {
      type: String,
      required: true,
      trim: true,
    },

    // WhatsApp Business Account ID (found in Meta Business Manager)
    businessAccountId: {
      type: String,
      default: "",
      trim: true,
    },

    // The actual WhatsApp phone number (e.g., "+919876543210")
    phoneNumber: {
      type: String,
      default: "",
      trim: true,
    },

    // Token you set in Meta webhook config — must match what Meta sends
    verifyToken: {
      type: String,
      required: true,
      trim: true,
    },

    // Graph API version to use (keep updated)
    graphApiVersion: {
      type: String,
      default: "v21.0",
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WhatsAppConfig", whatsAppConfigSchema);