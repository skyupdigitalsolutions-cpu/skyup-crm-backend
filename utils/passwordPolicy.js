// utils/passwordPolicy.js
// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD POLICY  (ISO/IEC 27001:2022 — A.5.17 Authentication information)
//
// Central place for password rules so every entry point (registration, admin
// creation, reset, change-password) enforces the same thing. Previously no
// model declared a minimum length, so a one-character password was accepted.
//
// Usage:
//   const { validatePassword } = require("../utils/passwordPolicy");
//   const { valid, errors } = validatePassword(pw, { email, name });
//   if (!valid) return res.status(400).json({ message: errors[0], errors });
// ─────────────────────────────────────────────────────────────────────────────

const MIN_LENGTH = Number(process.env.PASSWORD_MIN_LENGTH) || 12;
const MAX_LENGTH = 128; // bcrypt truncates past 72 bytes; cap input politely

// Small deny-list of the most abused passwords. This is NOT a substitute for a
// breach-corpus check — for that, wire in the Have I Been Pwned k-anonymity
// range API (see checkBreached below) which never transmits the password.
const COMMON = new Set([
  "password", "password1", "password123", "123456", "12345678", "123456789",
  "qwerty", "qwerty123", "abc123", "111111", "iloveyou", "admin", "admin123",
  "letmein", "welcome", "welcome1", "monkey", "dragon", "sunshine", "princess",
  "football", "changeme", "passw0rd", "p@ssw0rd", "test1234", "india123",
]);

/**
 * Validate a password against the policy.
 * @param {string} password
 * @param {{email?:string,name?:string}} [context] - used to reject passwords
 *        that simply echo the user's own identifiers.
 * @returns {{valid:boolean, errors:string[]}}
 */
function validatePassword(password, context = {}) {
  const errors = [];
  const pw = String(password || "");

  if (pw.length < MIN_LENGTH) errors.push(`Password must be at least ${MIN_LENGTH} characters.`);
  if (pw.length > MAX_LENGTH) errors.push(`Password must be at most ${MAX_LENGTH} characters.`);

  // Complexity: require 3 of 4 character classes. This is friendlier than
  // demanding all four while still ruling out trivially weak strings.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) {
    errors.push("Password must include at least three of: lowercase, uppercase, number, symbol.");
  }

  if (/^(.)\1+$/.test(pw)) errors.push("Password cannot be a single repeated character.");
  if (/^(?:0123456789|abcdefghij|qwertyuiop)/i.test(pw)) errors.push("Password cannot be a simple sequence.");

  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) errors.push("This password is too common — choose something less predictable.");

  // Reject passwords built from the account's own identifiers.
  const email = String(context.email || "").toLowerCase();
  const local = email.split("@")[0];
  const name  = String(context.name || "").toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) errors.push("Password must not contain your email address.");
  if (name) {
    for (const part of name.split(/\s+/)) {
      if (part.length >= 3 && lower.includes(part)) {
        errors.push("Password must not contain your name.");
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Optional breach check via the Have I Been Pwned range API (k-anonymity: only
 * the first 5 characters of the SHA-1 hash ever leave this server, so the
 * password itself is never transmitted).
 * Fails OPEN — a network problem must not block a legitimate password change.
 * @returns {Promise<boolean>} true when the password appears in known breaches.
 */
async function checkBreached(password) {
  try {
    const crypto = require("crypto");
    const axios  = require("axios");
    const sha1 = crypto.createHash("sha1").update(String(password)).digest("hex").toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const { data } = await axios.get(`https://api.pwnedpasswords.com/range/${prefix}`, { timeout: 4000 });
    return String(data).split("\n").some((line) => line.split(":")[0].trim() === suffix);
  } catch (_) {
    return false; // fail open
  }
}

/**
 * Prevent reuse of a recent password.
 * @param {string} newPassword
 * @param {string[]} previousHashes - bcrypt hashes of recent passwords
 */
async function isReused(newPassword, previousHashes = []) {
  if (!Array.isArray(previousHashes) || previousHashes.length === 0) return false;
  const bcrypt = require("bcryptjs");
  for (const hash of previousHashes) {
    try {
      if (hash && (await bcrypt.compare(newPassword, hash))) return true;
    } catch (_) { /* ignore malformed hash */ }
  }
  return false;
}

module.exports = { validatePassword, checkBreached, isReused, MIN_LENGTH };