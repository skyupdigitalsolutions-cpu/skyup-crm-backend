// middlewares/encryption.js
// ─────────────────────────────────────────────────────────────────────────────
// FIELD-LEVEL ENCRYPTION MIDDLEWARE
//
// SCOPE / ACCURACY NOTE (ISO 27001 A.8.24):
// This module performs SERVER-SIDE encryption. The server holds both
// encryptValue() and decryptValue() and can derive keys, so this is NOT a
// zero-knowledge design and must not be described as one in customer-facing
// material or the Statement of Applicability. It protects data at rest in the
// database (e.g. against a database-only compromise or backup leak); it does
// not protect data from the application server itself.
//
// CRYPTO DESIGN:
//   • AES-256-GCM (authenticated) — detects tampering, no padding oracle.
//   • Random 16-byte salt per record — keys are no longer identical across
//     tenants sharing a passphrase (the old code used the literal "salt").
//   • Random 12-byte nonce per record + stored GCM auth tag, verified on read.
//
// STORAGE FORMAT (new):  v2:<salt>:<iv>:<tag>:<ciphertext>   (all hex)
// LEGACY FORMAT (old):   <iv>:<ciphertext>                    (AES-256-CBC)
// Legacy values are still decryptable so existing records keep working; every
// value that is re-saved is written in the v2 format. Run the migration script
// to re-encrypt historical rows and then legacy support can be removed.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const Company = require("../models/Company");

// ── Fields that should be encrypted in Lead data ──────────────────────────────
const SENSITIVE_FIELDS = ["name", "mobile", "email", "remark", "voiceBotSummary", "voiceBotTranscript"];

// ── Key derivation ────────────────────────────────────────────────────────────
// scrypt with a RANDOM per-record salt. The salt is not secret and is stored
// alongside the ciphertext; its purpose is to make each derived key unique.
const deriveKey = (passphrase, salt) => crypto.scryptSync(String(passphrase), salt, 32);

const V2_PREFIX = "v2";

// ── Encrypt a single value (AES-256-GCM, authenticated) ───────────────────────
const encryptValue = (value, encryptionKey) => {
  try {
    if (!value || typeof value !== "string") return value;
    if (!encryptionKey) throw new Error("encryptionKey is required");
    const salt = crypto.randomBytes(16);
    const iv   = crypto.randomBytes(12);              // 96-bit nonce (GCM standard)
    const key  = deriveKey(encryptionKey, salt);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      V2_PREFIX,
      salt.toString("hex"),
      iv.toString("hex"),
      tag.toString("hex"),
      encrypted.toString("hex"),
    ].join(":");
  } catch (err) {
    // Never silently store plaintext — that would look encrypted but not be.
    console.error("Encryption error:", err.message);
    throw err;
  }
};

// ── Legacy reader: AES-256-CBC with the old hardcoded "salt" ──────────────────
// Retained ONLY so records written before the GCM migration remain readable.
const decryptLegacyCbc = (encryptedValue, encryptionKey) => {
  const [ivHex, encryptedHex] = encryptedValue.split(":");
  const iv  = Buffer.from(ivHex, "hex");
  const key = crypto.scryptSync(String(encryptionKey), "salt", 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
};

// ── Decrypt a single value (handles both v2 GCM and legacy CBC) ───────────────
const decryptValue = (encryptedValue, encryptionKey) => {
  try {
    if (!encryptedValue || typeof encryptedValue !== "string") return encryptedValue;
    if (!encryptedValue.includes(":")) return encryptedValue; // not encrypted

    const parts = encryptedValue.split(":");

    // v2 — authenticated. The auth tag is verified by decipher.final(), which
    // throws if the ciphertext or tag was tampered with.
    if (parts[0] === V2_PREFIX && parts.length === 5) {
      const [, saltHex, ivHex, tagHex, dataHex] = parts;
      const key = deriveKey(encryptionKey, Buffer.from(saltHex, "hex"));
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(dataHex, "hex")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    }

    // Legacy CBC (2 parts) — still readable, re-encrypted on next save.
    if (parts.length === 2) return decryptLegacyCbc(encryptedValue, encryptionKey);

    return encryptedValue;
  } catch (err) {
    // Wrong key, or the ciphertext/tag failed integrity verification.
    return "[ENCRYPTED]";
  }
};

// True when a stored value still uses the old unauthenticated format — used by
// the migration script to find records that need re-encrypting.
const isLegacyFormat = (v) =>
  typeof v === "string" && v.includes(":") && !v.startsWith(V2_PREFIX + ":") && v.split(":").length === 2;

// ── Hash a key for storage/verification ──────────────────────────────────────
const hashKey = (key) => {
  return crypto.createHash("sha256").update(key).digest("hex");
};

// ── Verify client's key matches stored hash ───────────────────────────────────
const verifyClientKey = (clientKey, storedHash) => {
  const keyHash = hashKey(clientKey);
  return keyHash === storedHash;
};

// ── Encrypt sensitive fields in lead data ─────────────────────────────────────
const encryptLeadData = (leadData, encryptionKey) => {
  const encrypted = { ...leadData };
  SENSITIVE_FIELDS.forEach(field => {
    if (encrypted[field]) {
      encrypted[field] = encryptValue(encrypted[field], encryptionKey);
    }
  });
  return encrypted;
};

// ── Decrypt sensitive fields in lead data ─────────────────────────────────────
const decryptLeadData = (leadData, encryptionKey) => {
  if (!leadData || !encryptionKey) return leadData;
  const decrypted = { ...leadData };
  SENSITIVE_FIELDS.forEach(field => {
    if (decrypted[field]) {
      decrypted[field] = decryptValue(decrypted[field], encryptionKey);
    }
  });
  return decrypted;
};

// ── Middleware: Check subscription status ─────────────────────────────────────
const checkSubscription = async (req, res, next) => {
  try {
    const companyId = req.admin?.company || req.user?.company;
    if (!companyId) return next();

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    // Check if company is active
    if (!company.isActive) {
      return res.status(403).json({ message: "Your company account is deactivated. Contact support." });
    }

    // Check subscription
    const now = new Date();

    if (company.subscriptionStatus === "active" && company.subscriptionExpiry) {
      if (now > company.subscriptionExpiry) {
        // Update to expired
        await Company.findByIdAndUpdate(companyId, { subscriptionStatus: "expired" });
        return res.status(403).json({
          message: "Your subscription has expired. Please renew to continue.",
          code: "SUBSCRIPTION_EXPIRED",
        });
      }
    }

    if (company.subscriptionStatus === "trial") {
      if (now > company.trialEndsAt) {
        await Company.findByIdAndUpdate(companyId, { subscriptionStatus: "expired" });
        return res.status(403).json({
          message: "Your free trial has ended. Please subscribe to continue.",
          code: "TRIAL_EXPIRED",
        });
      }
      // Trial still active — add warning header
      const daysLeft = Math.ceil((company.trialEndsAt - now) / (1000 * 60 * 60 * 24));
      res.setHeader("X-Trial-Days-Left", daysLeft);
    }

    if (company.subscriptionStatus === "expired" || company.subscriptionStatus === "cancelled") {
      return res.status(403).json({
        message: "Subscription inactive. Please renew to continue.",
        code: "SUBSCRIPTION_INACTIVE",
      });
    }

    next();
  } catch (err) {
    res.status(500).json({ message: "Subscription check failed" });
  }
};

module.exports = {
  isLegacyFormat,
  encryptValue,
  decryptValue,
  hashKey,
  verifyClientKey,
  encryptLeadData,
  decryptLeadData,
  checkSubscription,
  SENSITIVE_FIELDS,
};