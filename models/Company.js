// models/Company.js
const mongoose = require("mongoose");

const companySchema = mongoose.Schema(
  {
    name:    { type: String, required: true, trim: true },
    email:   { type: String, required: true, trim: true, unique: true },
    phone:   { type: String, trim: true },
    plan:    { type: String, enum: ["basic", "pro", "enterprise"], default: "basic" },
    isActive:{ type: Boolean, default: true },

    // ── Zero-Knowledge Privacy (BIP39 Mnemonic-based) ─────────────────────────
    //
    // HOW IT WORKS:
    //   1. Client generates a 12-word BIP39 mnemonic phrase on their device
    //   2. An AES-256 encryption key is derived from that phrase (first 32 bytes of seed)
    //   3. We store ONLY the SHA-256 hash of the derived hex key — not the key, not the phrase
    //   4. Client encrypts their lead data before sending to server
    //   5. Server stores only ciphertext — we see gibberish
    //   6. Client decrypts on their device using their mnemonic
    //
    // RECOVERY: If client loses their key, they can re-enter their 12-word phrase
    //           to regenerate the exact same key and recover all their data.
    //           This is the BIP39 advantage over random keys.
    //
    encryptionKeyHash: {
      type: String,
      default: null,
      // SHA-256 hash of the hex key derived from the mnemonic seed
      // Used ONLY to verify that the client has the correct phrase during login
      // CANNOT be reversed to obtain the key or phrase
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