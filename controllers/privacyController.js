// controllers/privacyController.js
const Company = require("../models/Company");
const {
  generateMnemonic,
  validateMnemonic,
  mnemonicToStoredHash,
  verifyMnemonicAgainstHash,
} = require("../utils/bip39Helper");

// ── Generate 12-word phrase for a company (called once on first setup) ────────
const setupEncryption = async (req, res) => {
  try {
    const companyId = req.admin.company._id || req.admin.company;

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    if (company.dataEncryptionEnabled) {
      return res.status(400).json({
        message: "Encryption already set up. To reset, contact support.",
        hint: "Use /api/privacy/verify to test your existing phrase.",
      });
    }

    // Generate 12-word mnemonic phrase
    const mnemonic = generateMnemonic();

    // Derive key and store ONLY the hash — never the mnemonic!
    const keyHash = mnemonicToStoredHash(mnemonic);

    company.encryptionKeyHash     = keyHash;
    company.dataEncryptionEnabled = true;
    await company.save();

    // Send phrase to admin — this is the ONLY time they will ever see it!
    res.status(200).json({
      success:  true,
      mnemonic, // ⚠️ Admin MUST save this — we never store it!
      words:    mnemonic.split(" ").map((word, i) => ({ index: i + 1, word })),
      warning:  "⚠️ SAVE THIS PHRASE NOW! It will NEVER be shown again. Without it your data cannot be recovered.",
      message:  "Encryption enabled. Store your 12-word phrase safely offline.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Verify client's mnemonic phrase is correct ────────────────────────────────
const verifyKey = async (req, res) => {
  try {
    const companyId = req.admin.company._id || req.admin.company;
    const { mnemonic } = req.body;

    if (!mnemonic) {
      return res.status(400).json({ message: "mnemonic phrase is required" });
    }

    if (!validateMnemonic(mnemonic)) {
      return res.status(400).json({
        valid:   false,
        message: "Invalid mnemonic format. Must be 12 valid BIP39 words.",
      });
    }

    const company = await Company.findById(companyId);
    if (!company || !company.dataEncryptionEnabled) {
      return res.status(400).json({ message: "Encryption not set up for this company" });
    }

    const isValid = verifyMnemonicAgainstHash(mnemonic, company.encryptionKeyHash);

    res.status(200).json({
      valid:   isValid,
      message: isValid
        ? "✅ Phrase verified successfully."
        : "❌ Incorrect phrase. Please check your 12-word recovery phrase.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Get encryption + subscription status ──────────────────────────────────────
const getEncryptionStatus = async (req, res) => {
  try {
    const companyId = req.admin.company._id || req.admin.company;
    const company   = await Company.findById(companyId).select(
      "name plan dataEncryptionEnabled subscriptionStatus subscriptionExpiry trialEndsAt"
    );

    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    const now           = new Date();
    const trialDaysLeft = company.trialEndsAt
      ? Math.max(0, Math.ceil((company.trialEndsAt - now) / (1000 * 60 * 60 * 24)))
      : 0;
    const subDaysLeft = company.subscriptionExpiry
      ? Math.max(0, Math.ceil((company.subscriptionExpiry - now) / (1000 * 60 * 60 * 24)))
      : 0;

    res.status(200).json({
      company:               company.name,
      plan:                  company.plan,
      dataEncryptionEnabled: company.dataEncryptionEnabled,
      subscriptionStatus:    company.subscriptionStatus,
      subscriptionExpiry:    company.subscriptionExpiry,
      trialEndsAt:           company.trialEndsAt,
      trialDaysLeft,
      subDaysLeft,
      // ⚠️ encryptionKeyHash is NEVER returned — security layer
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Disable encryption (SuperAdmin emergency use only) ────────────────────────
const disableEncryption = async (req, res) => {
  try {
    const company = await Company.findById(req.params.companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    company.dataEncryptionEnabled = false;
    company.encryptionKeyHash     = null;
    await company.save();

    res.status(200).json({
      success: true,
      message: "Encryption disabled.",
      warning: "⚠️ Previously encrypted data may not be readable without the original phrase.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Reset encryption — generate new phrase after disable (SuperAdmin only) ────
const resetEncryption = async (req, res) => {
  try {
    const { companyId } = req.body;
    if (!companyId) {
      return res.status(400).json({ message: "companyId is required in request body" });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res.status(404).json({ message: "Company not found" });
    }

    // Generate fresh 12-word phrase
    const mnemonic = generateMnemonic();
    const keyHash  = mnemonicToStoredHash(mnemonic);

    company.encryptionKeyHash     = keyHash;
    company.dataEncryptionEnabled = true;
    await company.save();

    res.status(200).json({
      success:  true,
      mnemonic, // ⚠️ Must be saved immediately — never shown again
      words:    mnemonic.split(" ").map((word, i) => ({ index: i + 1, word })),
      warning:  "⚠️ New phrase generated. Old encrypted data is permanently unreadable. Save this phrase now!",
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
  resetEncryption,   // ✅ now exported — fixes the crash!
};