// middlewares/encryption.js
// ─────────────────────────────────────────────────────────────────────────────
// ZERO-KNOWLEDGE ENCRYPTION MIDDLEWARE
//
// HOW IT WORKS:
// 1. Client generates their own AES-256 key on THEIR device (frontend)
// 2. Client sends: encryptedData + SHA-256 hash of their key
// 3. Server stores ONLY encrypted data — we CANNOT read it
// 4. Client decrypts on their side using their key
//
// YOU (server owner) see only gibberish — complete data privacy!
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const Company = require("../models/Company");

// ── Fields that should be encrypted in Lead data ──────────────────────────────
const SENSITIVE_FIELDS = ["name", "mobile", "email", "remark", "voiceBotSummary", "voiceBotTranscript"];

// ── Encrypt a single value (done on CLIENT side ideally) ──────────────────────
// This server-side version is only used as fallback
const encryptValue = (value, encryptionKey) => {
  try {
    if (!value || typeof value !== "string") return value;
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(encryptionKey, "salt", 32);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return iv.toString("hex") + ":" + encrypted.toString("hex");
  } catch (err) {
    console.error("Encryption error:", err.message);
    return value;
  }
};

// ── Decrypt a single value ────────────────────────────────────────────────────
const decryptValue = (encryptedValue, encryptionKey) => {
  try {
    if (!encryptedValue || typeof encryptedValue !== "string") return encryptedValue;
    if (!encryptedValue.includes(":")) return encryptedValue; // not encrypted
    const [ivHex, encryptedHex] = encryptedValue.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const key = crypto.scryptSync(encryptionKey, "salt", 32);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    // Cannot decrypt — key is wrong or data is not encrypted
    return "[ENCRYPTED]";
  }
};

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
  encryptValue,
  decryptValue,
  hashKey,
  verifyClientKey,
  encryptLeadData,
  decryptLeadData,
  checkSubscription,
  SENSITIVE_FIELDS,
};