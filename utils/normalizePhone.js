/**
 * normalizePhone.js  — Central phone normalization utility
 *
 * ALL phone normalization in this CRM goes through this file.
 * One place to update when new country codes are added.
 *
 * Rules (in order):
 *  1. Strip all non-digit characters (spaces, +, -, (, ), .)
 *  2. Strip known country-code prefixes: 0091, 091, 91 (India), 001, 01 (US/CA)
 *  3. Strip a single leading 0 (local trunk dialing)
 *  4. Return last 10 digits
 *  5. If result is not exactly 10 digits → return null (invalid / landline / test data)
 *
 * Returns: 10-digit string (e.g. "9876543210") | null
 */

const COUNTRY_CODE_PREFIXES = [
  '0091', '091', '0044', '044',  // India (91), UK (44)
  '001',  '01',                   // US/Canada (1)
  '0049', '049',                  // Germany (49)
  '0061', '061',                  // Australia (61)
  '0971', '971',                  // UAE (971)
  '0966', '966',                  // Saudi Arabia (966)
];

/**
 * Normalize a phone number to its last 10 digits.
 * @param {string|number} raw  — any format
 * @returns {string|null}      — 10-digit string or null if invalid
 */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;

  // Convert to string and remove every non-digit character
  let digits = String(raw).replace(/\D/g, '');

  if (!digits) return null;

  // Strip known country-code prefixes (longest first to avoid partial match)
  for (const prefix of COUNTRY_CODE_PREFIXES) {
    if (digits.startsWith(prefix) && digits.length > prefix.length) {
      digits = digits.slice(prefix.length);
      break;
    }
  }

  // Strip single leading 0 (trunk prefix used in India, UK, etc.)
  if (digits.startsWith('0') && digits.length > 10) {
    digits = digits.slice(1);
  }

  // If still too long, keep the last 10 digits
  if (digits.length > 10) {
    digits = digits.slice(-10);
  }

  // Must be exactly 10 digits to be valid (Indian mobile + most international)
  if (digits.length !== 10) return null;

  // Basic sanity: must not be all the same digit (e.g. 0000000000)
  if (/^(\d)\1{9}$/.test(digits)) return null;

  return digits;
}

/**
 * Same as normalizePhone but never throws — returns null on any error.
 * Safe to use in webhooks / untrusted input.
 */
function normalizePhoneSafe(raw) {
  try {
    return normalizePhone(raw);
  } catch {
    return null;
  }
}

/**
 * Returns true if two phone values represent the same number.
 */
function isSamePhone(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na !== null && nb !== null && na === nb;
}

module.exports = { normalizePhone, normalizePhoneSafe, isSamePhone };
