const User = require("../models/Users");

/**
 * Google sends user_column_data as:
 *   [{ column_name: "Full Name", column_id: "FULL_NAME", string_value: "John Doe" }, ...]
 *
 * We key by `column_id` (always uppercase, always consistent) with a fallback
 * to normalised `column_name` for any custom fields Google may add in future.
 *
 * Examples of column_id values Google sends:
 *   FULL_NAME, EMAIL, PHONE_NUMBER, CITY, ZIP_CODE, COUNTRY, etc.
 */
const parseGoogleLeadData = (userColumnData = []) => {
  const result = {};
  userColumnData.forEach(({ column_id, column_name, string_value }) => {
    // Primary key: column_id lowercased (e.g. "FULL_NAME" → "full_name")
    if (column_id) {
      const key = column_id.toLowerCase();
      result[key] = string_value || "";
    }
    // Fallback: normalised column_name (spaces → underscores)
    if (column_name) {
      const key = column_name.toLowerCase().replace(/\s+/g, "_");
      // Only set if not already set by column_id to avoid overwriting
      if (!(column_id && column_id.toLowerCase() in result)) {
        result[key] = string_value || "";
      }
    }
  });
  return result;
};

// Round-robin assignment across active users of the company
const getNextAssignedUserGoogle = async (config) => {
  const GoogleAdsConfig = require("../models/GoogleAdsConfig");

  const users = await User.find({ company: config.company, isActive: { $ne: false } })
    .select("_id")
    .lean();

  if (!users || users.length === 0) {
    console.warn(`⚠️  No active users for company ${config.company} — lead will be unassigned`);
    return null;
  }

  const updated = await GoogleAdsConfig.findByIdAndUpdate(
    config._id,
    { $inc: { roundRobinIndex: 1 } },
    { new: false }
  );

  const index = (updated.roundRobinIndex || 0) % users.length;
  return users[index]._id;
};

// Map normalised Google fields → Lead schema
// column_id values are lowercased, so we look up "full_name", "phone_number", "email", etc.
const mapGoogleLeadToSchema = (parsed, config, googleLeadId, assignedUserId) => {
  const firstName = parsed["first_name"] || "";
  const lastName  = parsed["last_name"]  || "";

  // Google standard column_id for full name is FULL_NAME → "full_name"
  const fullName =
    parsed["full_name"] ||
    `${firstName} ${lastName}`.trim() ||
    "Unknown";

  // Google standard column_id for phone is PHONE_NUMBER → "phone_number"
  const mobile =
    parsed["phone_number"] ||
    parsed["phone"]        ||
    "";

  return {
    leadgenId: googleLeadId,
    name:      fullName,
    mobile:    mobile.replace(/\D/g, ""),   // digits only
    email:     parsed["email"] || "",
    source:    "Google Ads",
    campaign:  config.campaignName,
    status:    config.defaultStatus,
    date:      new Date(),
    remark:    config.defaultRemark,
    user:      assignedUserId,
    company:   config.company,
  };
};

module.exports = { parseGoogleLeadData, getNextAssignedUserGoogle, mapGoogleLeadToSchema };
