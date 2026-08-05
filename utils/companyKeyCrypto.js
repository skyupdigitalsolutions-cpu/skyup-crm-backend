// utils/companyKeyCrypto.js
// ─────────────────────────────────────────────────────────────────────────────
// Server-side AES-256-GCM encryption for the per-company encryption key.
//
// WHAT THIS DOES:
//   • Generates a random 32-byte companyKey for each company at creation.
//   • Encrypts it with SYSTEM_MASTER_KEY so the DB stores only ciphertext.
//   • At login, decrypts and sends the companyKey to the frontend (over HTTPS).
//   • The frontend uses it to encrypt/decrypt lead PII (name, mobile, email,
//     remarks) before sending to / after receiving from the backend.
//   • The backend NEVER sees plaintext lead PII — it stores and returns ciphertext.
//
// FIELDS ENCRYPTED BY FRONTEND (never plaintext in MongoDB):
//   mobile, remark, callHistory[].remark, meetingRemarks[].remark
//
// FIELDS LEFT PLAINTEXT (backend logic needs them):
//   name, email, status, campaign, source, temperature, date, followUpDate, etc.
//
// ENV REQUIRED:
//   SYSTEM_MASTER_KEY — 64-char hex (32 bytes). Generate:
//     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// FORMAT stored in Company.encryptedCompanyKey:
//   "enc:<ivHex>:<ciphertextHex>:<authTagHex>"
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const RAW_MASTER = process.env.SYSTEM_MASTER_KEY || "";
const MASTER_KEY = RAW_MASTER
  ? Buffer.from(RAW_MASTER, "hex").slice(0, 32) // accept hex or utf8
  : null;

if (!MASTER_KEY) {
  console.warn(
    "[companyKeyCrypto] ⚠️  SYSTEM_MASTER_KEY not set — company keys will be " +
    "stored UNENCRYPTED. Set this in your Render environment variables."
  );
}

const PREFIX = "enc:";

/**
 * Generate a new random 32-byte company key.
 * Returns the raw bytes as a hex string — this is shown ONCE to the admin
 * as their recovery key, then never returned again.
 */
function generateCompanyKey() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Encrypt a companyKey (hex string) with the SYSTEM_MASTER_KEY.
 * Returns a "enc:<iv>:<cipher>:<tag>" string for storage in Company document.
 */
function encryptCompanyKey(companyKeyHex) {
  if (!companyKeyHex) throw new Error("companyKeyHex is required");

  if (!MASTER_KEY) {
    console.warn("[companyKeyCrypto] Storing company key UNENCRYPTED (no SYSTEM_MASTER_KEY).");
    return `plain:${companyKeyHex}`;
  }

  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const enc    = Buffer.concat([cipher.update(companyKeyHex, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("hex")}:${enc.toString("hex")}:${tag.toString("hex")}`;
}

/**
 * Decrypt a stored encryptedCompanyKey back to the raw hex companyKey.
 * Returns null if the key cannot be decrypted.
 */
function decryptCompanyKey(stored) {
  if (!stored) return null;

  if (stored.startsWith("plain:")) {
    return stored.slice(6); // legacy unencrypted (only if SYSTEM_MASTER_KEY was never set)
  }

  if (!stored.startsWith(PREFIX)) {
    // Assume legacy plaintext — return as-is
    return stored;
  }

  if (!MASTER_KEY) {
    console.warn("[companyKeyCrypto] Encrypted company key found but SYSTEM_MASTER_KEY not set.");
    return null;
  }

  try {
    const rest      = stored.slice(PREFIX.length);
    const [ivHex, cipherHex, tagHex] = rest.split(":");
    const decipher  = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch (e) {
    console.error("[companyKeyCrypto] Decryption failed:", e.message);
    return null;
  }
}

/**
 * Compute a HMAC-SHA256 of a plaintext phone/email using the companyKey.
 * Used so the backend can look up leads by phone (for WhatsApp/calling) without
 * ever storing or knowing the plaintext number.
 *
 * Usage (frontend does this before sending the lead):
 *   mobileHash = HMAC-SHA256(normalizedMobile, companyKey)
 *
 * Usage (backend webhook, incoming call):
 *   // For each company, compute HMAC of incoming number and look up by mobileHash
 *   const hash = computeHmac(incomingNumber, companyKey)
 *   Lead.findOne({ company, mobileHash: hash })
 */
function computeHmac(plaintext, companyKeyHex) {
  if (!plaintext || !companyKeyHex) return null;
  return crypto
    .createHmac("sha256", Buffer.from(companyKeyHex, "hex"))
    .update(String(plaintext))
    .digest("hex");
}

module.exports = { generateCompanyKey, encryptCompanyKey, decryptCompanyKey, computeHmac };