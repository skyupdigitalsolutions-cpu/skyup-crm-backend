const axios  = require("axios");
const User   = require("../models/Users");

// ── Fetch lead data from Meta Graph API ───────────────────────────────────────
const fetchLeadData = async (leadgenId, pageAccessToken, graphApiVersion) => {
  const version = graphApiVersion || process.env.META_GRAPH_API_VERSION || "v21.0";
  try {
    const response = await axios.get(
      `https://graph.facebook.com/${version}/${leadgenId}`,
      { params: { fields: "created_time,field_data", access_token: pageAccessToken } }
    );
    return response.data;
  } catch (err) {
    console.error(`Failed to fetch lead ${leadgenId}:`, err?.response?.data || err.message);
    throw err;
  }
};

// ── Convert Meta's field_data array → plain key-value object ─────────────────
const parseFieldData = (fieldData) => {
  const result = {};
  fieldData.forEach(({ name, values }) => {
    result[name] = values[0];
  });
  return result;
};

// ── Pick next user via round robin & advance the pointer atomically ───────────
//   Uses findOneAndUpdate so concurrent webhook calls don't assign to the same user.
const getNextAssignedUser = async (config) => {
  const MetaConfig = require("../models/MetaConfig");

  // Get all active users belonging to this company
  const users = await User.find({ company: config.company, isActive: { $ne: false } })
    .select("_id")
    .lean();

  if (!users || users.length === 0) {
    console.warn(`No users found for company ${config.company} — lead will be unassigned`);
    return null;
  }

  const total = users.length;

  // Atomically grab current index and increment (wraps with modulo on read)
  const updated = await MetaConfig.findByIdAndUpdate(
    config._id,
    { $inc: { roundRobinIndex: 1 } },
    { new: false } // return the doc BEFORE increment so we use the current index
  );

  const currentIndex = (updated.roundRobinIndex || 0) % total;
  return users[currentIndex]._id;
};

// ── Map Meta fields → Lead schema ─────────────────────────────────────────────
const mapToLeadSchema = (parsedFields, config, leadgenId, assignedUserId) => {
  // Build a remark that captures the custom Meta form fields
  const extraFields = [
    parsedFields["what_type_of_business_do_you_run?"]      && `Business: ${parsedFields["what_type_of_business_do_you_run?"]}`,
    parsedFields["what_service_are_you_interested_in?"]    && `Service: ${parsedFields["what_service_are_you_interested_in?"]}`,
    parsedFields["what_is_your_monthly_marketing_budget?"] && `Budget: ${parsedFields["what_is_your_monthly_marketing_budget?"]}`,
    parsedFields["what_is_the_best_time_for_our_team_to_contact_you?"] && `Best time: ${parsedFields["what_is_the_best_time_for_our_team_to_contact_you?"]}`,
  ].filter(Boolean).join(" | ");

  return {
    leadgenId,

    name:
      parsedFields["full_name"] ||
      (parsedFields["first_name"]
        ? `${parsedFields["first_name"] || ""} ${parsedFields["last_name"] || ""}`.trim()
        : "Unknown"),

    mobile: (parsedFields["phone_number"] || parsedFields["mobile"] || "").replace(/\D/g, ""),

    email:  parsedFields["email"] || parsedFields["email_address"] || "",

    source:   "Meta",
    campaign: config.campaignName,
    status:   config.defaultStatus,
    date:     new Date(),
    remark:   extraFields || config.defaultRemark,
    user:     assignedUserId,
    company:  config.company,
  };
};

module.exports = { fetchLeadData, parseFieldData, mapToLeadSchema, getNextAssignedUser };