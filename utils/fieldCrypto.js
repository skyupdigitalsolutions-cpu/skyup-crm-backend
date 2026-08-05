// utils/fieldCrypto.js
// ─────────────────────────────────────────────────────────────────────────────
// AES-256-GCM encryption/decryption for sensitive MongoDB fields.
//
// Same algorithm as tokenCrypto.js (which handles Google OAuth tokens).
// This module covers ALL other sensitive fields: MSG91 auth keys, Meta page
// access tokens, Brevo API keys, Razorpay tokens, Cloudinary secrets, etc.
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
//
// NESTED FIELDS (added):
//   The plugin now accepts dot-paths, e.g. "cloudinaryConfig.apiSecret".
//   Top-level fields behave exactly as before — this change is additive and
//   backward-compatible.
//
// ⚠️  DO NOT use this plugin on a field that is queried BY VALUE (e.g. a
//   webhookSecret matched with findOne({ webhookSecret })). GCM uses a random
//   IV, so the same plaintext encrypts to different ciphertext every time and
//   an equality lookup will never match. Such fields need a deterministic HMAC
//   index instead — see note in models/WebsiteConfig.js.
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

// ── Dot-path helpers (support nested subdocument fields) ──────────────────────
function getPath(obj, path) {
  if (!obj) return undefined;
  if (!path.includes(".")) return obj[path];
  return path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  if (!obj) return;
  if (!path.includes(".")) { obj[path] = value; return; }
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((acc, key) => {
    if (acc[key] == null || typeof acc[key] !== "object") acc[key] = {};
    return acc[key];
  }, obj);
  target[last] = value;
}

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
 * auto-decrypt on find. Supports both top-level and nested (dot-path) fields.
 *
 * Usage:
 *   const { encryptedFieldsPlugin } = require("../utils/fieldCrypto");
 *   schema.plugin(encryptedFieldsPlugin, {
 *     fields: ["msg91AuthKey", "pageAccessToken", "cloudinaryConfig.apiSecret"],
 *   });
 */
function encryptedFieldsPlugin(schema, options = {}) {
  const fields = options.fields || [];
  if (!fields.length) return;

  // Encrypt before save (covers .save() and pre-save hooks).
  // this.get / this.set / this.isModified all understand dot-paths natively.
  schema.pre("save", function (next) {
    for (const field of fields) {
      if (this.isModified(field)) {
        const val = this.get(field);
        if (val) this.set(field, encrypt(val));
      }
    }
    next();
  });

  // Encrypt before findOneAndUpdate / updateOne / updateMany.
  function encryptUpdate() {
    const update = this.getUpdate();
    if (!update) return;

    for (const field of fields) {
      // Direct dot-path key form: { "cloudinaryConfig.apiSecret": val }
      if (update[field] !== undefined) {
        update[field] = encrypt(update[field]);
      }
      if (update.$set && update.$set[field] !== undefined) {
        update.$set[field] = encrypt(update.$set[field]);
      }
      // Nested-object form: { cloudinaryConfig: { apiSecret: val } }
      if (field.includes(".")) {
        const nestedTop = getPath(update, field);
        if (nestedTop !== undefined && update[field] === undefined) {
          setPath(update, field, encrypt(nestedTop));
        }
        if (update.$set) {
          const nestedSet = getPath(update.$set, field);
          if (nestedSet !== undefined && update.$set[field] === undefined) {
            setPath(update.$set, field, encrypt(nestedSet));
          }
        }
      }
    }
  }
  schema.pre("findOneAndUpdate", encryptUpdate);
  schema.pre("updateOne",        encryptUpdate);
  schema.pre("updateMany",       encryptUpdate);

  // Decrypt after all find operations (works for hydrated docs and lean objects)
  function decryptDoc(doc) {
    if (!doc) return;
    for (const field of fields) {
      const val = getPath(doc, field);
      if (val) setPath(doc, field, decrypt(val));
    }
  }

  schema.post("find",            function (docs) { (docs || []).forEach(decryptDoc); });
  schema.post("findOne",         decryptDoc);
  schema.post("findOneAndUpdate",decryptDoc);
  schema.post("findOneAndDelete",decryptDoc);
  schema.post("save",            decryptDoc);
}

/**
 * Deterministic keyed hash for fields that must be looked up BY VALUE while
 * their real value is stored encrypted (e.g. WebsiteConfig.webhookSecret).
 *
 * Unlike encrypt() — which uses a random IV so the same input yields different
 * output every time — hmac() is DETERMINISTIC: the same plaintext always maps
 * to the same hash, so you can do findOne({ webhookSecretHash: hmac(incoming) }).
 * It is one-way: the plaintext cannot be recovered from the hash.
 *
 * Keyed with FIELD_ENCRYPTION_KEY so the hash is meaningless without the secret.
 */
function hmac(value) {
  if (value == null || value === "") return "";
  const hmacKey = KEY || crypto.createHash("sha256").update("fieldcrypto-fallback").digest();
  if (!KEY) {
    console.warn("[fieldCrypto] hmac() called without FIELD_ENCRYPTION_KEY — using insecure fallback key. Set the env var!");
  }
  return crypto.createHmac("sha256", hmacKey).update(String(value)).digest("hex");
}

module.exports = { encrypt, decrypt, hmac, encryptedFieldsPlugin };