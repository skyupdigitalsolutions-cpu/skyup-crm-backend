// utils/findLeadByPhone.js
// Unified phone lookup across primaryPhone and secondaryPhone.
// Use this everywhere instead of ad-hoc Lead.findOne({ mobile: ... }) calls.
const { normalizePhone } = require("./normalizePhone");

/**
 * Find a single lead by phone number, searching BOTH primaryPhone and secondaryPhone.
 *
 * @param {string|number} phoneNumber  - Raw phone number (any format)
 * @param {ObjectId|string} companyId  - Company scope (required)
 * @param {object} [extraFilter={}]    - Extra Mongoose filter conditions
 * @param {string|object} [projection] - Optional Mongoose projection
 * @returns {Promise<Lead|null>}
 */
async function findLeadByPhone(phoneNumber, companyId, extraFilter = {}, projection = null) {
  const Lead = require("../models/Leads");
  const norm = normalizePhone(String(phoneNumber || ""));
  if (!norm || !companyId) return null;

  const query = {
    company: companyId,
    $or: [
      { normalizedPhone:          norm },
      { normalizedSecondaryPhone: norm },
      // Legacy fallback for leads that haven't been migrated yet
      { mobile:        norm          },
      { mobile:        `91${norm}`   },
    ],
    ...extraFilter,
  };

  return projection
    ? Lead.findOne(query).select(projection)
    : Lead.findOne(query);
}

/**
 * Find ALL leads matching a phone number (both primary + secondary).
 * Useful for de-dup reports.
 */
async function findAllLeadsByPhone(phoneNumber, companyId) {
  const Lead = require("../models/Leads");
  const norm = normalizePhone(String(phoneNumber || ""));
  if (!norm || !companyId) return [];

  return Lead.find({
    company: companyId,
    $or: [
      { normalizedPhone:          norm },
      { normalizedSecondaryPhone: norm },
      { mobile:                   norm },
    ],
  });
}

/**
 * Determine the number type for a given phone on a lead.
 * Returns "Primary", "Secondary", "Additional", or null.
 */
function getNumberType(lead, phoneNumber) {
  const norm = normalizePhone(String(phoneNumber || ""));
  if (!norm) return null;

  if (lead.normalizedPhone === norm) return "Primary";
  if (lead.normalizedSecondaryPhone && lead.normalizedSecondaryPhone === norm) return "Secondary";

  const isAdditional = (lead.additionalNumbers || []).some(
    (n) => normalizePhone(String(n.number || "")) === norm
  );
  if (isAdditional) return "Additional";

  return null;
}

module.exports = { findLeadByPhone, findAllLeadsByPhone, getNumberType };
