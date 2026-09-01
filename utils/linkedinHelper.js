const axios = require("axios");
const User  = require("../models/Users");
const { normalizePhoneSafe } = require("./normalizePhone");

// ── Fetch the full lead form response from LinkedIn's Lead Sync API ──────────
// The webhook notification only carries a leadFormResponse URN — the actual
// answers have to be fetched separately, same two-step pattern LinkedIn's own
// docs describe (notification → GET the real data), analogous to Meta's
// leadgen webhook only carrying a leadgenId that also needs a follow-up fetch.
const fetchLeadData = async (leadFormResponseUrn, accessToken) => {
  try {
    // URNs are URL-unsafe as-is (contain colons) — LinkedIn's REST API expects
    // them URL-encoded when used as a path/query parameter.
    const encoded = encodeURIComponent(leadFormResponseUrn);
    const response = await axios.get(
      `https://api.linkedin.com/rest/leadFormResponses/${encoded}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "LinkedIn-Version": "202401",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );
    return response.data;
  } catch (err) {
    console.error(`[LinkedIn] Failed to fetch lead ${leadFormResponseUrn}:`, err?.response?.data || err.message);
    throw err;
  }
};

// ── Convert LinkedIn's answers[] array → plain key-value object ──────────────
// LinkedIn's standard questions are identified by well-known URNs (e.g.
// "urn:li:leadGenFormQuestion:firstName"), while custom questions carry the
// question TEXT the form creator wrote instead. This normalizes both into a
// single flat object, storing under an easily-matched short key AND the
// original raw key — same dual-key strategy as metaHelper.js's parseFieldData,
// for the same reason: never assume the exact key shape ahead of time.
const STANDARD_QUESTION_URN_MAP = {
  "urn:li:leadGenFormQuestion:firstName":    "first_name",
  "urn:li:leadGenFormQuestion:lastName":     "last_name",
  "urn:li:leadGenFormQuestion:email":        "email",
  "urn:li:leadGenFormQuestion:phoneNumber":  "phone_number",
  "urn:li:leadGenFormQuestion:companyName":  "company_name",
  "urn:li:leadGenFormQuestion:jobTitle":     "job_title",
};

const parseFieldData = (leadResponseData) => {
  const result = {};
  const answers = leadResponseData?.answers || leadResponseData?.leadFormResponse?.answers || [];

  for (const a of answers) {
    // LinkedIn's answer shape (per Lead Sync API docs): { question: <urn or text>, answer: { textQuestionAnswer: { answer: "..." } } }
    // Different question types (text, single-select, multi-select) nest the
    // actual value slightly differently — try the common shapes rather than
    // assuming one.
    const value =
      a?.answer?.textQuestionAnswer?.answer ??
      a?.answer?.singleSelectAnswer?.answer ??
      a?.answer?.multipleChoiceAnswer?.answers?.join(", ") ??
      a?.answerDetails?.text ??
      "";

    const questionKey = a?.question || a?.questionUrn || "";
    const knownKey = STANDARD_QUESTION_URN_MAP[questionKey];

    if (knownKey) {
      result[knownKey] = value;
    } else {
      // Custom question — store under its own text/urn as the key, normalized
      // the same way metaHelper.js normalizes Meta's field names.
      const rawLabel = a?.questionText || questionKey || `custom_${Object.keys(result).length}`;
      const normKey = String(rawLabel).toLowerCase().replace(/\s+/g, "_");
      result[normKey] = value;
      result[rawLabel] = value;
    }
  }

  return result;
};

// ── Find phone value regardless of exactly how it was captured ───────────────
const PHONE_KEYS = ["phone_number", "phone", "mobile", "mobile_number", "contact_number", "contact"];
function extractPhone(parsedFields) {
  for (const k of PHONE_KEYS) {
    const v = parsedFields[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  // Fallback: scan every value for something that looks like a phone number.
  for (const v of Object.values(parsedFields)) {
    const digits = String(v || "").replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) return digits;
  }
  return "";
}

// ── Round-robin assignment — identical mechanism to utils/metaHelper.js's
// getNextAssignedUser(), just pointed at LinkedInConfig instead of MetaConfig.
const LinkedInConfig = require("../models/LinkedInConfig");

const getNextAssignedUser = async (config) => {
  let users = await User.find({
    company: config.company,
    createdBy: config.createdBy || undefined,
    isActive: { $ne: false },
  }).select("_id").lean();

  if (!users || users.length === 0) {
    users = await User.find({ company: config.company, isActive: { $ne: false } }).select("_id").lean();
  }

  if (!users || users.length === 0) {
    console.warn("[LinkedInRoundRobin] No users found for company", String(config.company), "— lead will be unassigned");
    return null;
  }

  const total = users.length;
  const updated = await LinkedInConfig.findByIdAndUpdate(
    config._id,
    { $inc: { roundRobinIndex: 1 } },
    { new: false }
  );

  const currentIndex = (updated.roundRobinIndex || 0) % total;
  return users[currentIndex]._id;
};

// ── Map LinkedIn fields → Lead schema ─────────────────────────────────────────
const mapToLeadSchema = (parsedFields, config, leadFormResponseUrn, assignedUserId) => {
  const { computeQuality } = require("./qualityHelper");

  const STANDARD_KEYS = new Set([
    "first_name", "last_name", "email", "phone_number", "company_name", "job_title",
  ]);

  const extraAnswers = Object.entries(parsedFields)
    .filter(([k]) => !STANDARD_KEYS.has(k))
    .map(([, v]) => v);

  const extraFields = Object.entries(parsedFields)
    .filter(([k]) => !STANDARD_KEYS.has(k))
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join(" | ");

  const name = `${parsedFields["first_name"] || ""} ${parsedFields["last_name"] || ""}`.trim() || "Unknown";

  const raw    = extractPhone(parsedFields);
  const norm   = normalizePhoneSafe(raw);
  const mobile = norm || raw.replace(/\D/g, "") || "";

  const email = parsedFields["email"] || "";

  const temperature = computeQuality(
    { name, mobile, email, _extraAnswers: extraAnswers },
    extraAnswers.length
  );

  return {
    // Reuses the SAME leadgenId field (and its company-scoped unique index)
    // Meta/Google Ads already use for webhook idempotency — a
    // leadFormResponse URN is just as valid an opaque dedup key.
    leadgenId: leadFormResponseUrn,
    name,
    mobile,
    email,
    source:           "LinkedIn",
    campaign:         config.campaignName,
    adSetName:        config.adCampaignName || "",
    linkedinConfigId: config._id,
    status:           config.defaultStatus,
    date:             new Date(),
    remark:           extraFields || config.defaultRemark,
    temperature,
    user:             assignedUserId,
    company:          config.company,
    // ── Lead Nurture tags — from campaign config default, same convention
    // as Meta's mapToLeadSchema. LinkedIn's standard fields (companyName,
    // jobTitle) don't map to an industry/service the way Meta's custom
    // questions sometimes do, so this only ever uses the config's own
    // default — no per-lead override attempted here.
    ...(config.industry ? { industry: config.industry } : {}),
    ...(config.service  ? { service:  config.service  } : {}),
  };
};

module.exports = { fetchLeadData, parseFieldData, extractPhone, mapToLeadSchema, getNextAssignedUser };
