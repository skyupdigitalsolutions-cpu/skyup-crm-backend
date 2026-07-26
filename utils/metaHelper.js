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
// Stores BOTH the original key AND a lowercased/underscore-normalised key
// so lookups work regardless of how the form creator named the field.
const parseFieldData = (fieldData) => {
  const result = {};
  fieldData.forEach(({ name, values }) => {
    const val = values && values[0] != null ? values[0] : "";
    // Store under original name (e.g. "Phone Number", "PHONE_NUMBER", "phone_number")
    result[name] = val;
    // Also store under normalised key (lowercase, spaces→underscores)
    const normKey = name.toLowerCase().replace(/\s+/g, "_");
    if (!(normKey in result)) result[normKey] = val;
  });
  return result;
};

// ── Find phone value from parsedFields regardless of key name ─────────────────
// Meta form creators can name the phone field anything.
// Strategy: check known keys first, then fall back to scanning ALL values
// for something that looks like a phone number (5-15 digits).
const PHONE_KEYS = [
  "phone_number", "phone", "mobile", "mobile_number",
  "contact_number", "contact", "cell", "cell_number",
  "whatsapp", "whatsapp_number", "tel", "telephone",
  "number", "mob", "ph",
];

const NAME_KEYS = new Set([
  "full_name", "first_name", "last_name", "name",
]);
const EMAIL_KEYS = new Set([
  "email", "email_address", "email_id",
]);

function extractPhone(parsedFields) {
  // 1. Check all known key variants (exact + normalised)
  for (const k of PHONE_KEYS) {
    const v = parsedFields[k];
    if (v && String(v).trim()) {
      console.log(`   📞 Phone matched via known key: field="${k}", value="${v}"`);
      return String(v).trim();
    }
  }

  // 2. Scan ALL field values — pick first one that looks like a phone
  for (const [k, v] of Object.entries(parsedFields)) {
    if (!v || NAME_KEYS.has(k) || EMAIL_KEYS.has(k)) continue;
    const s     = String(v).trim();
    const digits = s.replace(/\D/g, "");
    // Phone-like: 5-15 digits, no @ sign, not all letters
    if (
      digits.length >= 5 &&
      digits.length <= 15 &&
      !s.includes("@") &&
      !/^[a-zA-Z\s]+$/.test(s)
    ) {
      console.log(`   📞 Phone found via value-scan: field="${k}", value="${v}"`);
      return s;
    }
  }

  console.warn("   ⚠️  No phone field found in parsedFields. Keys received:", Object.keys(parsedFields));
  return "";
}

// ── Pick next user via round robin & advance the pointer atomically ───────────
const getNextAssignedUser = async (config) => {
  const MetaConfig = require("../models/MetaConfig");

  // Scope to only employees assigned to the admin who owns this Meta config.
  // This prevents leads from one admin's campaign going to another admin's employees.
  const userFilter = { company: config.company, isActive: { $ne: false } };

  if (config.createdBy) {
    // createdBy is set — filter to employees under that admin only
    userFilter.createdBy = config.createdBy;
  }
  // else: no createdBy (legacy config) — fall back to all company users

  let users = await User.find(userFilter).select("_id").lean();

  // Fallback: if admin has no employees assigned, use all company users
  if (!users || users.length === 0) {
    users = await User.find({ company: config.company, isActive: { $ne: false } }).select("_id").lean();
  }

  if (!users || users.length === 0) {
    console.warn("[MetaRoundRobin] No users found for company", String(config.company), "— lead will be unassigned");
    return null;
  }

  const total = users.length;

  const updated = await MetaConfig.findByIdAndUpdate(
    config._id,
    { $inc: { roundRobinIndex: 1 } },
    { new: false }
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
    "phone_number", "phone", "mobile", "mobile_number",
    "contact_number", "contact", "cell", "cell_number",
    "whatsapp", "whatsapp_number", "tel", "telephone", "number", "mob", "ph",
    "email", "email_address", "email_id",
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

  // Smart phone extraction — never returns "N/A"
  const raw    = extractPhone(parsedFields);
  const norm   = normalizePhoneSafe(raw);
  const mobile = norm || raw.replace(/\D/g, "") || "";

  console.log(`   📱 Phone raw="${raw}" → norm="${norm}" → saved="${mobile}"`);

  const email = parsedFields["email"] || parsedFields["email_address"] || parsedFields["email_id"] || "";

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
    adSetName:   config.adSetName || "",
    metaConfigId: config._id,
    status:      config.defaultStatus,
    date:        new Date(),
    remark:      extraFields || config.defaultRemark,
    temperature,
    user:        assignedUserId,
    company:     config.company,
  };
};

module.exports = { fetchLeadData, parseFieldData, mapToLeadSchema, getNextAssignedUser };
