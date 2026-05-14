const axios  = require("axios");
const User   = require("../models/Users");
const { normalizePhoneSafe } = require("./normalizePhone");

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
  const { computeQuality } = require("./qualityHelper");

  // Standard Meta question keys — used to detect "extra" campaign questions
  const STANDARD_META_KEYS = new Set([
    "full_name", "first_name", "last_name",
    "phone_number", "mobile", "email", "email_address",
  ]);

  // Collect all non-standard (custom campaign) field values
  const extraAnswers = Object.entries(parsedFields)
    .filter(([k]) => !STANDARD_META_KEYS.has(k))
    .map(([, v]) => v);

  const totalCampaignQuestions = extraAnswers.length;

  // Build remark from extra fields
  const extraFields = Object.entries(parsedFields)
    .filter(([k]) => !STANDARD_META_KEYS.has(k))
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join(" | ");

  const name =
    parsedFields["full_name"] ||
    (parsedFields["first_name"]
      ? `${parsedFields["first_name"] || ""} ${parsedFields["last_name"] || ""}`.trim()
      : "Unknown");

  const raw    = parsedFields["phone_number"] || parsedFields["mobile"] || "";
  const norm   = normalizePhoneSafe(raw);
  const mobile = norm || raw.replace(/\D/g, "") || "N/A";

  const email = parsedFields["email"] || parsedFields["email_address"] || "";

  // Compute quality
  const temperature = computeQuality(
    { name, mobile, email, _extraAnswers: extraAnswers },
    totalCampaignQuestions
  );

  return {
    leadgenId,
    name,
    mobile,
    email,
    source:      "Meta",
    campaign:    config.campaignName,
    status:      config.defaultStatus,
    date:        new Date(),
    remark:      extraFields || config.defaultRemark,
    temperature,          // ← AUTO QUALITY
    user:        assignedUserId,
    company:     config.company,
  };
};

module.exports = { fetchLeadData, parseFieldData, mapToLeadSchema, getNextAssignedUser };