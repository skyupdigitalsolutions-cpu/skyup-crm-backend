// utils/getLeadDisplayName.js
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for resolving a human-readable display name for a
// WhatsApp contact or lead.
//
// Problem: Inbound WhatsApp numbers from unknown callers often carry no name
// at all — WhatsApp sends either an empty string, the raw phone number, or
// a gibberish system-generated token (e.g. "SJSJASSS") as `customerName`.
// When that value is used as the {{1}} body variable in a template ("Hi
// SJSJASSS, ...") or as the lead name in the CRM, it looks unprofessional
// and confusing.
//
// Solution: whenever a name is unavailable, empty, or clearly not a real
// person's name (just digits / auto-generated pattern), fall back to
// "Sir/Madam" — a neutral, polite salutation that works for both genders
// and all cultures.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the supplied string looks like a real human name.
 * Rejects:
 *   • empty / whitespace-only
 *   • purely numeric strings (raw phone numbers)
 *   • strings that are only punctuation / special chars
 *   • the literal placeholder "WhatsApp <digits>" that the CRM itself
 *     generates when auto-creating a lead for an unknown caller
 *
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
function isRealName(name) {
  if (!name || typeof name !== "string") return false;

  const trimmed = name.trim();
  if (!trimmed) return false;

  // Pure digits (phone number leaked into name field)
  if (/^\+?\d[\d\s\-().]+$/.test(trimmed)) return false;

  // CRM auto-generated fallback ("WhatsApp 919876543210")
  if (/^whatsapp\s+\d+$/i.test(trimmed)) return false;

  // Only non-letter characters (emoji, punctuation, symbols)
  if (!/[a-zA-Z\u0080-\uFFFF]/.test(trimmed)) return false;

  return true;
}

/**
 * Resolve the best display name for a WhatsApp lead/contact.
 *
 * Priority order:
 *   1. contactName   (from WhatsApp profile, captured at webhook time)
 *   2. leadName      (from the CRM Lead document)
 *   3. "Sir/Madam"  (neutral fallback when neither is available or real)
 *
 * @param {object} opts
 * @param {string} [opts.contactName]   - Name from WhatsApp profile / MSG91 payload
 * @param {string} [opts.leadName]      - Name stored on the Lead record
 * @returns {string}                    - Always a non-empty string
 */
function getLeadDisplayName({ contactName, leadName } = {}) {
  if (isRealName(contactName)) return contactName.trim();
  if (isRealName(leadName))    return leadName.trim();
  return "Sir/Madam";
}

/**
 * Convenience: resolve display name from a Lead document.
 * Pass the full lead object (or just its `name` field).
 *
 * @param {object|null} lead
 * @param {string} [overrideContactName]  - contactName from the WA conversation
 * @returns {string}
 */
function getLeadDisplayNameFromDoc(lead, overrideContactName) {
  return getLeadDisplayName({
    contactName: overrideContactName,
    leadName:    lead?.name,
  });
}

module.exports = { getLeadDisplayName, getLeadDisplayNameFromDoc, isRealName };
