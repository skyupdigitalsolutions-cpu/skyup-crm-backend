// models/TermsAcceptance.js
// ─────────────────────────────────────────────────────────────────────────────
// Records that a specific user accepted a specific T&C version.
//
// `userId` + `version` is unique — a user accepts a given version exactly once.
// When a NEW version is published, there is no acceptance row for it yet, so the
// gate re-appears until the user accepts the new version (creating a new row).
//
// `role` and `userModel` are stored for auditing (which collection the identity
// lives in). `company` is stored where applicable for per-tenant reporting.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require("mongoose");
const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");

const termsAcceptanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    // Which Mongoose model the identity belongs to.
    userModel: {
      type: String,
      enum: ["User", "Admin", "SuperAdmin", "Developer"],
      required: true,
    },

    role:    { type: String, default: "" }, // user | admin | super_admin | developer
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", default: null },

    version:    { type: Number, required: true, index: true },
    acceptedAt: { type: Date,   default: Date.now },
    ipAddress:  { type: String, default: null },
  },
  { timestamps: true }
);

// A user accepts each version at most once.
termsAcceptanceSchema.index({ userId: 1, version: 1 }, { unique: true });

// ── Encrypt the acceptance IP at rest ────────────────────────────────────────
// NOTE: ipAddress is written via updateOne(..., { $setOnInsert: { ipAddress } },
// { upsert:true }). The plugin's update hook now covers $setOnInsert (see
// utils/fieldCrypto.js) — REQUIRED, otherwise new acceptances store the IP in
// plaintext. Decrypted on read. Not queried by value / not indexed → safe.
termsAcceptanceSchema.plugin(encryptedFieldsPlugin, { fields: ["ipAddress"] });

const TermsAcceptance = mongoose.model("TermsAcceptance", termsAcceptanceSchema);
module.exports = TermsAcceptance;