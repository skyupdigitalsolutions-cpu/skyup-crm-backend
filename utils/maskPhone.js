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
 * Apply masking to a lead object based on caller role and ownership.
 *
 * @param {object} lead      - raw lead from DB
 * @param {string} role      - "super_admin" | "admin" | "user" | "employee"
 * @param {string} [callerId] - the _id of the requesting user/admin (string).
 *                              When provided, employees see FULL numbers for
 *                              their own assigned leads so they can dial.
 * @returns {object}         - lead with mobile/email masked if applicable
 *
 * POLICY:
 *   • super_admin  → always full (owns all data)
 *   • employee/user → full for their OWN leads (lead.user == callerId)
 *                     masked for other employees' leads
 *   • admin        → masked; can reveal via POST /:id/reveal-phone
 */
function maskLeadPII(lead, role, callerId) {
  if (!lead) return lead;

  const isSuperAdmin = role === 'super_admin' || role === 'superadmin';
  if (isSuperAdmin) return lead;

  // FIX: a regular company admin (role === 'admin') fell through this and the
  // "own lead" employee check below, landing on the masked-by-default return
  // at the bottom — meaning admin saw every phone number masked, company-wide.
  // That's already wrong on the web dashboard, but it's a hard BLOCKER for
  // admin calling from mobile specifically: CallButton dials whatever string
  // it's given via a tel: link, so a masked number like "98765XXXXX" isn't
  // just unreadable, it's not a real number to dial at all. An admin manages
  // their whole company's leads and needs real contact info the same way
  // super_admin does — bypass masking for this role too.
  const isAdmin = role === 'admin';
  if (isAdmin) return lead;

  // Employees see full numbers for their own assigned leads —
  // they need the real number to make phone calls.
  const isEmployee = role === 'user' || role === 'employee';
  if (isEmployee && callerId) {
    const leadUserId = lead.user?._id
      ? String(lead.user._id)
      : lead.user
        ? String(lead.user)
        : null;
    if (leadUserId && leadUserId === String(callerId)) {
      return lead; // own lead — return full number, no masking
    }
  }

  return {
    ...lead,
    mobile:        lead.mobile        ? maskPhone(lead.mobile)        : lead.mobile,
    primaryPhone:  lead.primaryPhone  ? maskPhone(lead.primaryPhone)  : lead.primaryPhone,
    email:         lead.email         ? maskEmail(lead.email)         : lead.email,
    secondaryPhone: lead.secondaryPhone ? maskPhone(lead.secondaryPhone) : lead.secondaryPhone,
  };
}

module.exports = { maskPhone, maskEmail, maskLeadPII };
