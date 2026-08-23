// utils/maskPhone.js  (backend)
// ─────────────────────────────────────────────────────────────────────────────
// Shared masking helpers used by leadController, reportController, and any
// other controller that returns mobile/email data to the client.
//
// POLICY:
//   • super_admin  → always sees full number (they own the data)
//   • admin        → sees masked number in API responses; can reveal via
//                    POST /lead/:id/reveal-phone (logged to audit trail)
//   • employee     → sees masked number always; no reveal endpoint
//
// These run SERVER-SIDE so even DevTools Network tab shows masked values
// for non-superadmin roles — the raw number never leaves the backend.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mask a phone number — shows last 2 digits only.
 * e.g. "919876543210" → "••••••••••10"
 * e.g. "9876543210"   → "••••••••10"
 */
function maskPhone(phone) {
  if (!phone) return '—';
  const s = String(phone);
  if (s.length <= 2) return '••••••••';
  return '•'.repeat(s.length - 2) + s.slice(-2);
}

/**
 * Mask an email address.
 * e.g. "john.doe@example.com" → "jo••••oe@•••••••.com"
 */
function maskEmail(email) {
  if (!email) return undefined;
  const atIdx = email.indexOf('@');
  if (atIdx < 0) return '•'.repeat(8);
  const local  = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  let maskedLocal;
  if (local.length <= 2) {
    maskedLocal = '•'.repeat(local.length);
  } else {
    const mid = Math.max(1, local.length - 4);
    maskedLocal = local.slice(0, 2) + '•'.repeat(mid) + local.slice(-2);
  }
  const dotIdx = domain.lastIndexOf('.');
  const maskedDomain = dotIdx > 0
    ? '•'.repeat(dotIdx) + domain.slice(dotIdx)
    : '•'.repeat(domain.length);
  return `${maskedLocal}@${maskedDomain}`;
}

/**
 * Apply masking to a lead object based on caller role.
 * @param {object} lead      - raw lead from DB
 * @param {string} role      - "super_admin" | "admin" | "user" | "employee"
 * @returns {object}         - lead with mobile/email masked if not super_admin
 */
function maskLeadPII(lead, role) {
  if (!lead) return lead;
  const isSuperAdmin = role === 'super_admin' || role === 'superadmin';
  if (isSuperAdmin) return lead;          // super_admin sees everything raw
  return {
    ...lead,
    mobile:       lead.mobile       ? maskPhone(lead.mobile)       : lead.mobile,
    primaryPhone: lead.primaryPhone ? maskPhone(lead.primaryPhone) : lead.primaryPhone,
    email:        lead.email        ? maskEmail(lead.email)        : lead.email,
    // secondaryPhone also masked
    secondaryPhone: lead.secondaryPhone ? maskPhone(lead.secondaryPhone) : lead.secondaryPhone,
  };
}

module.exports = { maskPhone, maskEmail, maskLeadPII };
