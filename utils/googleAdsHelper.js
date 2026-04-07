const User = require("../models/Users");

// Google sends user_column_data as array of { column_name, string_value }
const parseGoogleLeadData = (userColumnData = []) => {
  const result = {};
  userColumnData.forEach(({ column_name, string_value }) => {
    result[column_name.toLowerCase()] = string_value;
  });
  return result;
};

// Round-robin — same logic as your Meta helper
const getNextAssignedUserGoogle = async (config) => {
  const GoogleAdsConfig = require("../models/GoogleAdsConfig");

  const users = await User.find({ company: config.company, isActive: { $ne: false } })
    .select("_id")
    .lean();

  if (!users || users.length === 0) {
    console.warn(`No users for company ${config.company} — lead unassigned`);
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

// Map Google fields → your Lead schema
const mapGoogleLeadToSchema = (parsed, config, googleLeadId, assignedUserId) => {
  const firstName = parsed["first_name"] || "";
  const lastName  = parsed["last_name"]  || "";
  const fullName  = parsed["full_name"]  || `${firstName} ${lastName}`.trim() || "Unknown";

  return {
    leadgenId: googleLeadId,   // reuse leadgenId field for deduplication
    name:      fullName,
    mobile:    (parsed["phone_number"] || parsed["phone"] || "").replace(/\D/g, ""),
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