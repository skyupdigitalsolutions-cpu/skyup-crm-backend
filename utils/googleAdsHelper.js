const User = require("../models/Users");

/**
 * Google sends user_column_data as:
 *   [{ column_name: "FULL_NAME", string_value: "John Doe" }, ...]
 *
 * We normalise column_name to lowercase + underscores so lookups are consistent
 * whether Google sends "phone number", "PHONE_NUMBER", or "phone_number".
 */
const parseGoogleLeadData = (userColumnData = []) => {
  const result = {};
  userColumnData.forEach(({ column_name, string_value }) => {
    if (!column_name) return;
    // Normalise: lowercase, replace spaces with underscores
    const key = column_name.toLowerCase().replace(/\s+/g, "_");
    result[key] = string_value || "";
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
const mapGoogleLeadToSchema = (parsed, config, googleLeadId, assignedUserId) => {
  const firstName = parsed["first_name"] || "";
  const lastName  = parsed["last_name"]  || "";
  // Google may send full_name directly, or we build it from first+last
  const fullName  =
    parsed["full_name"] ||
    `${firstName} ${lastName}`.trim() ||
    "Unknown";

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
