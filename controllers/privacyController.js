// controllers/privacyController.js
// ─────────────────────────────────────────────────────────────────────────────
// Handles Zero-Knowledge encryption setup for each company/client
// The actual encryption key NEVER reaches this controller
// We only store a HASH of the key for verification purposes
// ─────────────────────────────────────────────────────────────────────────────

const Company = require("../models/Company");
const { hashKey, verifyClientKey } = require("../middlewares/encryption");

// ── Setup encryption for a company (called once by admin) ────────────────────
// Client sends: SHA-256 hash of their key (NOT the key itself!)
const setupEncryption = async (req, res) => {
  try {
    const companyId = req.admin.company;
    const { keyHash } = req.body;

    if (!keyHash) {
      return res.status(400).json({
        message: "keyHash is required. Generate it on your device: SHA256(yourEncryptionKey)",
      });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    if (company.dataEncryptionEnabled) {
      return res.status(400).json({
        message: "Encryption already set up. To reset, contact support.",
      });
    }

    // Store ONLY the hash — never the actual key
    company.encryptionKeyHash = keyHash;
    company.dataEncryptionEnabled = true;
    await company.save();

    res.status(200).json({
      success: true,
      message: "Encryption enabled. Your data is now private — we cannot read it.",
      warning: "⚠️ Keep your encryption key safe. If lost, your data cannot be recovered.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Verify client's key is correct ───────────────────────────────────────────
const verifyKey = async (req, res) => {
  try {
    const companyId = req.admin.company;
    const { keyHash } = req.body;

    const company = await Company.findById(companyId);
    if (!company || !company.dataEncryptionEnabled) {
      return res.status(400).json({ message: "Encryption not set up for this company" });
    }

    const isValid = company.encryptionKeyHash === keyHash;

    res.status(200).json({
      valid: isValid,
      message: isValid ? "Key verified successfully" : "Invalid key",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Get encryption status for company ────────────────────────────────────────
const getEncryptionStatus = async (req, res) => {
  try {
    const companyId = req.admin.company;
    const company = await Company.findById(companyId).select(
      "dataEncryptionEnabled subscriptionStatus subscriptionExpiry trialEndsAt plan"
    );

    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    const now = new Date();
    const trialDaysLeft = company.trialEndsAt
      ? Math.max(0, Math.ceil((company.trialEndsAt - now) / (1000 * 60 * 60 * 24)))
      : 0;

    res.status(200).json({
      dataEncryptionEnabled: company.dataEncryptionEnabled,
      subscriptionStatus: company.subscriptionStatus,
      subscriptionExpiry: company.subscriptionExpiry,
      trialEndsAt: company.trialEndsAt,
      trialDaysLeft,
      plan: company.plan,
      // We NEVER return encryptionKeyHash — extra safety
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Disable encryption (emergency — contact support flow) ─────────────────────
const disableEncryption = async (req, res) => {
  try {
    // Only superadmin can disable — not the company admin
    const company = await Company.findById(req.params.companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    company.dataEncryptionEnabled = false;
    company.encryptionKeyHash = null;
    await company.save();

    res.status(200).json({
      success: true,
      message: "Encryption disabled. Note: Previously encrypted data may not be readable without the key.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  setupEncryption,
  verifyKey,
  getEncryptionStatus,
  disableEncryption,
};