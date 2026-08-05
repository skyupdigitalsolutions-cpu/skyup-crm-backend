const mongoose = require("mongoose");
const { encryptedFieldsPlugin, hmac } = require("../utils/fieldCrypto");

const websiteConfigSchema = new mongoose.Schema(
  {
    sourceName:      { type: String, required: true },

    // The shared secret between the website's GTM tag and this CRM.
    // Stored ENCRYPTED at rest (fieldCrypto plugin below) so a database dump
    // never exposes it. It is auto-decrypted on read, so the admin UI still
    // sees the real value to copy into GTM.
    //
    // NOTE: `unique: true` was removed — an encrypted value uses a random IV,
    // so identical secrets would store as different ciphertext and a unique
    // index would be meaningless. Uniqueness + lookups now go through the
    // deterministic `webhookSecretHash` below. After running the migration,
    // drop the old Atlas index `webhookSecret_1`.
    webhookSecret:   { type: String, required: true },

    // Deterministic HMAC of webhookSecret — this is what the inbound webhook
    // matches against (findOne by hash), since the real value is encrypted and
    // can't be matched by equality. Computed automatically in the hooks below.
    webhookSecretHash: { type: String, default: "", index: true },

    // ── Secret rotation support (A.5.17) ─────────────────────────────────────
    // Retired secrets that are still accepted during a rotation window. This
    // makes rotation ZERO-DOWNTIME: the webhook keeps accepting the old secret
    // while the GTM tag is updated, so no website lead is ever dropped.
    // Clear these once the logs show the old secret is no longer in use.
    //
    // `previousSecrets` (legacy plaintext) is kept only for backward-compat with
    // rows not yet migrated. New rotations should populate `previousSecretHashes`
    // (deterministic HMACs) instead; the migration moves existing values over.
    previousSecrets:      { type: [String], default: [] },
    previousSecretHashes: { type: [String], default: [] },

    pageUrl:         { type: String, default: "" },
    isActive:        { type: Boolean, default: true },
    defaultStatus:   { type: String, default: "New" },
    defaultRemark:   { type: String, default: "Lead from Website" },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Company",
      required: true,
    },
    // Owning admin — stamped at creation. null = legacy/shared config visible to all admins.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Admin",
      default: null,
    },
    roundRobinIndex: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// ── Compute the deterministic hash from PLAINTEXT, BEFORE the encrypt plugin ──
// These hooks are registered BEFORE encryptedFieldsPlugin, so they run first
// and see the still-plaintext webhookSecret. The plugin then encrypts it.
websiteConfigSchema.pre("save", function (next) {
  if (this.isModified("webhookSecret") && this.webhookSecret && !String(this.webhookSecret).startsWith("v1:")) {
    this.webhookSecretHash = hmac(this.webhookSecret);
  }
  next();
});

function computeHashOnUpdate() {
  const u = this.getUpdate();
  if (!u) return;
  const raw =
    u.webhookSecret !== undefined ? u.webhookSecret
    : u.$set && u.$set.webhookSecret !== undefined ? u.$set.webhookSecret
    : undefined;
  if (raw !== undefined && raw && !String(raw).startsWith("v1:")) {
    const h = hmac(raw);
    if (u.$set) u.$set.webhookSecretHash = h;
    else u.webhookSecretHash = h;
  }
}
websiteConfigSchema.pre("findOneAndUpdate", computeHashOnUpdate);
websiteConfigSchema.pre("updateOne",        computeHashOnUpdate);

// Encrypt the scalar secret at rest (auto-decrypts on read for the admin UI).
websiteConfigSchema.plugin(encryptedFieldsPlugin, { fields: ["webhookSecret"] });

module.exports = mongoose.model("WebsiteConfig", websiteConfigSchema);