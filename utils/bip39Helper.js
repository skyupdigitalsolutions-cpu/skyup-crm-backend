// utils/bip39Helper.js
// ─────────────────────────────────────────────────────────────────────────────
// BIP39 Mnemonic Key Derivation Helper
//
// WHY BIP39?
//   A normal random AES key is a string like "a3f9b1c2d4e5..." — impossible to
//   memorize or write down reliably. If lost, data is gone forever.
//
//   BIP39 uses a wordlist of 2048 common English words. 12 words chosen from
//   this list encode 128 bits of entropy — same security as a random 128-bit key,
//   but HUMAN-READABLE. A user can write "apple orange river moon ..." on paper.
//
//   The 12 words → a 64-byte seed (via PBKDF2) → we take first 32 bytes as AES-256 key.
//   Same words ALWAYS → same seed → same key → same decryption. This IS the recovery.
//
// USAGE (server side):
//   const { generateMnemonic, deriveKeyFromMnemonic, validateMnemonic } = require('./bip39Helper');
//   const mnemonic = generateMnemonic();                  // "apple banana ..."
//   const hexKey   = deriveKeyFromMnemonic(mnemonic);     // "a3f9b1c2..." (64 hex chars)
//
// USAGE (frontend):
//   See CRMEncryption.js — the browser does the same derivation using bip39 npm pkg.
// ─────────────────────────────────────────────────────────────────────────────

const bip39  = require("bip39");
const crypto = require("crypto");

// ── Generate a new random 12-word mnemonic ────────────────────────────────────
// Call this on the FRONTEND (CRMEncryption.js does this).
// This server-side version is here only for testing/admin scripts.
const generateMnemonic = () => {
  return bip39.generateMnemonic(); // 128 bits of entropy → 12 words
};

// ── Derive a 32-byte AES-256 key (as hex) from a mnemonic ────────────────────
// DETERMINISTIC: same mnemonic → same key, every time, forever.
// This is the recovery mechanism.
const deriveKeyFromMnemonic = (mnemonic) => {
  const normalized = mnemonic.trim().toLowerCase();
  if (!bip39.validateMnemonic(normalized)) {
    throw new Error("Invalid mnemonic: must be 12 valid BIP39 words separated by spaces.");
  }
  const seed = bip39.mnemonicToSeedSync(normalized); // 64-byte Buffer (PBKDF2 internally)
  return seed.slice(0, 32).toString("hex");           // first 32 bytes = AES-256 key
};

// ── Validate a mnemonic phrase ────────────────────────────────────────────────
const validateMnemonic = (mnemonic) => {
  return bip39.validateMnemonic(mnemonic.trim().toLowerCase());
};

// ── Hash a derived key for DB storage ─────────────────────────────────────────
// Store this in Company.encryptionKeyHash — never store the key or mnemonic.
const hashDerivedKey = (hexKey) => {
  return crypto.createHash("sha256").update(hexKey).digest("hex");
};

// ── Full pipeline: mnemonic → key → hash (used in setup) ─────────────────────
const mnemonicToStoredHash = (mnemonic) => {
  const hexKey = deriveKeyFromMnemonic(mnemonic);
  return hashDerivedKey(hexKey);
};

// ── Verify: mnemonic matches stored hash (used in login verify) ───────────────
const verifyMnemonicAgainstHash = (mnemonic, storedHash) => {
  try {
    const hexKey      = deriveKeyFromMnemonic(mnemonic);
    const computedHash = hashDerivedKey(hexKey);
    return computedHash === storedHash;
  } catch {
    return false;
  }
};

module.exports = {
  generateMnemonic,
  deriveKeyFromMnemonic,
  validateMnemonic,
  hashDerivedKey,
  mnemonicToStoredHash,
  verifyMnemonicAgainstHash,
};