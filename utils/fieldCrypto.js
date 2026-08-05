// utils/fieldCrypto.js
// ─────────────────────────────────────────────────────────────────────────────
// AES-256-GCM encryption/decryption for sensitive MongoDB fields.
//
// Same algorithm as tokenCrypto.js (which handles Google OAuth tokens).
// This module covers ALL other sensitive fields: MSG91 auth keys, Meta page
// access tokens, Brevo API keys, Razorpay tokens, etc.
//
// ENVIRONMENT VARIABLE:
//   FIELD_ENCRYPTION_KEY — set a strong random secret (min 32 chars).
//   Generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// FORMAT stored in MongoDB:
//   "v1:<ivHex>:<authTagHex>:<ciphertextHex>"
//   Legacy (unencrypted) values are returned as-is on first read.
//
// MIGRATION:
//   Existing plaintext values in MongoDB are returned as-is (backward-compatible).
//   They are re-encrypted the next time that document is saved. Run a one-time
//   migration script (scripts/encryptExistingFields.js) to encrypt all at once.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const RAW_KEY = process.env.FIELD_ENCRYPTION_KEY || "";
// Derive a fixed 32-byte key from the secret (SHA-256 so any length input works)
const KEY = RAW_KEY
  ? crypto.createHash("sha256").update(RAW_KEY).digest()
  : null;

if (!KEY) {
  console.warn(
    "[fieldCrypto] ⚠️  FIELD_ENCRYPTION_KEY not set — sensitive fields will be " +
    "stored UNENCRYPTED. Set it in your environment variables immediately."
  );
}

const PREFIX = "v1:";

/**
 * Encrypt a plaintext string.
 * Returns a "v1:<iv>:<tag>:<ciphertext>" string, or the original value if
 * the key is not configured.
 */
function encrypt(plain) {
  if (plain == null || plain === "") return plain;
  const s = String(plain);

  // Already encrypted — don't double-encrypt
  if (s.startsWith(PREFIX)) return s;

  if (!KEY) {
    console.warn("[fieldCrypto] Storing value UNENCRYPTED (no FIELD_ENCRYPTION_KEY).");
    return s;
  }

  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc    = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/**
 * Decrypt a value previously encrypted by encrypt().
 * Returns the original plaintext, or the value unchanged if it was never
 * encrypted (backward-compatible with existing data).
 */
function decrypt(stored) {
  if (stored == null || stored === "") return stored;
  const s = String(stored);

  // Not encrypted — return as-is (legacy plaintext in DB)
  if (!s.startsWith(PREFIX)) return s;

  if (!KEY) {
    console.warn("[fieldCrypto] Encrypted value found but FIELD_ENCRYPTION_KEY not set — cannot decrypt.");
    return null;
  }

  try {
    const parts = s.slice(PREFIX.length).split(":");
    if (parts.length !== 3) throw new Error("Invalid format");
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch (e) {
    console.error("[fieldCrypto] Decryption failed:", e.message);
    return null;
  }
}

/**
 * Mongoose plugin — attach to a schema to auto-encrypt fields on save and
 * auto-decrypt on find.
 *
 * Usage:
 *   const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");
 *   schema.plugin(encryptedFieldsPlugin, { fields: ["msg91AuthKey", "pageAccessToken"] });
 */
function encryptedFieldsPlugin(schema, options = {}) {
  const fields = options.fields || [];
  if (!fields.length) return;

  // Encrypt before save (covers .save() and pre-save hooks)
  schema.pre("save", function (next) {
    for (const field of fields) {
      if (this.isModified(field) && this[field]) {
        this[field] = encrypt(this[field]);
      }
    }
    next();
  });

  // Encrypt before findOneAndUpdate / updateOne / updateMany
  function encryptUpdate() {
    const update = this.getUpdate();
    if (!update) return;

    // Handle both { field: val } and { $set: { field: val } }
    for (const field of fields) {
      if (update[field] !== undefined) {
        update[field] = encrypt(update[field]);
      }
      if (update.$set && update.$set[field] !== undefined) {
        update.$set[field] = encrypt(update.$set[field]);
      }
    }
  }
  schema.pre("findOneAndUpdate", encryptUpdate);
  schema.pre("updateOne",        encryptUpdate);
  schema.pre("updateMany",       encryptUpdate);

  // Decrypt after all find operations
  function decryptDoc(doc) {
    if (!doc) return;
    for (const field of fields) {
      if (doc[field]) doc[field] = decrypt(doc[field]);
    }
  }

  schema.post("find",            function (docs) { docs.forEach(decryptDoc); });
  schema.post("findOne",         decryptDoc);
  schema.post("findOneAndUpdate",decryptDoc);
  schema.post("findOneAndDelete",decryptDoc);
  schema.post("save",            decryptDoc);
}

module.exports = { encrypt, decrypt, encryptedFieldsPlugin };