// controllers/smsCampaignController.js
// SMS Blasting via MSG91 — supports campaign (CRM leads), single, and CSV modes.
// MSG91 API v5 docs: https://docs.msg91.com/reference/send-sms
//
// Auth Key is now read from SmsConfig (DB, per-company) first,
// falling back to process.env.MSG91_AUTH_KEY if not set in DB.

const axios     = require("axios");
const Lead      = require("../models/Leads");
const SmsLog    = require("../models/SmsLog");
const SmsConfig = require("../models/SmsConfig"); // ← NEW

// ── Helper: get auth key + sender ID for a company ───────────────────────────
// Reads ONLY from SmsConfig (DB) — strictly company-scoped.
// No .env fallback: each company must configure their own MSG91 credentials
// so one company's key never leaks into another company's SMS sends.
async function getCompanySmsCredentials(companyId) {
  const config = await SmsConfig.findOne({ company: companyId });
  return {
    authKey:  config?.msg91AuthKey  || "",
    senderId: config?.msg91SenderId || "SKYCRM",
  };
}

// ── MSG91 SMS sender (v5 JSON API) ───────────────────────────────────────────
// Uses MSG91's modern v5 REST API with JSON body (not the legacy sendhttp.php).
// MSG91 requires DLT-registered template IDs for Indian numbers.
const sendViaMSG91 = async ({ mobile, message, templateId, senderId, authKey }) => {
  if (!authKey) {
    throw new Error(
      "MSG91 Auth Key not configured. Go to SMS Settings (gear icon) and save your Auth Key."
    );
  }

  // Normalize: strip all non-digits, then ensure country code prefix
  let phone = mobile.replace(/\D/g, "");
  // If 10 digits (Indian local), prefix with 91
  if (phone.length === 10) phone = "91" + phone;

  const payload = {
    sender:  senderId || "SKYCRM",
    route:   "4", // 4 = transactional, 1 = promotional
    country: "91",
    sms: [
      {
        message,
        to: [phone],
      },
    ],
  };

  // DLT template_id is required for Indian numbers — attach if provided
  if (templateId) payload.template_id = templateId;

  const { data } = await axios.post(
    "https://api.msg91.com/api/v5/flow/",
    payload,
    {
      headers: {
        authkey:        authKey,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
    },
  );

  // MSG91 v5 returns { type: "success", message: "..." } on success
  if (
    data?.type === "error" ||
    (typeof data === "string" && data.toLowerCase().startsWith("error"))
  ) {
    throw new Error(`MSG91 error: ${data?.message || data}`);
  }

  return data?.message || data?.requestId || "sent";
};

// ── Helper: persist an SMS log ────────────────────────────────────────────────
const saveLog = async ({
  to,
  recipientName,
  message,
  templateId,
  senderId,
  campaignId,
  status,
  errorMessage,
  msg91RequestId,
  companyId,
}) => {
  try {
    await SmsLog.create({
      to,
      recipientName,
      message,
      templateId,
      senderId,
      campaignId,
      status,
      errorMessage:   errorMessage   || null,
      msg91RequestId: msg91RequestId || null,
      company:        companyId,
    });
  } catch (err) {
    console.error("SmsLog save failed:", err.message);
  }
};

// ── Background bulk sender (non-blocking) ─────────────────────────────────────
async function runSmsInBackground({
  leads,
  message,
  templateId,
  senderId,
  companyId,
  campaignId,
  authKey,       // ← passed from controller after DB lookup
}) {
  const CONCURRENCY = 5;
  let sent = 0, failed = 0;

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const chunk = leads.slice(i, i + CONCURRENCY);

    await Promise.all(
      chunk.map(async (lead) => {
        // Merge-tag substitution
        const body = message
          .replace(/{{name}}/g,     lead.name     || "")
          .replace(/{{mobile}}/g,   lead.mobile   || "")
          .replace(/{{email}}/g,    lead.email    || "")
          .replace(/{{campaign}}/g, lead.campaign || "");

        try {
          const requestId = await sendViaMSG91({
            mobile: lead.mobile,
            message: body,
            templateId,
            senderId,
            authKey, // ← use company-specific key
          });
          sent++;
          await saveLog({
            to:             lead.mobile,
            recipientName:  lead.name,
            message:        body,
            templateId,
            senderId,
            campaignId,
            status:         "sent",
            msg91RequestId: String(requestId),
            companyId,
          });
        } catch (err) {
          failed++;
          await saveLog({
            to:            lead.mobile,
            recipientName: lead.name,
            message:       body,
            templateId,
            senderId,
            campaignId,
            status:        "failed",
            errorMessage:  err.message,
            companyId,
          });
        }
      }),
    );
  }

  console.log(
    `📱 SMS Campaign "${campaignId}" complete — sent: ${sent}, failed: ${failed}, total: ${leads.length}`,
  );
}

// ── POST /api/sms-campaign/send ───────────────────────────────────────────────
const sendBulkSms = async (req, res) => {
  try {
    const { campaign, message, templateId, senderId } = req.body;
    if (!campaign || !message) {
      return res.status(400).json({ message: "campaign and message are required" });
    }

    // ── Fetch company SMS credentials from DB ─────────────────────────────
    const companyId = req.admin.company._id;
    const creds     = await getCompanySmsCredentials(companyId);
    const authKey   = creds.authKey;

    if (!authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Go to SMS Settings (gear icon) and save your Auth Key first.",
      });
    }

    const leads = await Lead.find({
      company: companyId,
      campaign,
      mobile: { $exists: true, $ne: "" },
    })
      .select("name mobile email campaign")
      .lean();

    if (leads.length === 0) {
      return res.status(404).json({
        message: `No leads with mobile numbers found in campaign "${campaign}"`,
      });
    }

    res.json({
      success: true,
      message: `SMS blast started for ${leads.length} leads in "${campaign}"`,
      total:   leads.length,
    });

    runSmsInBackground({
      leads,
      message,
      templateId: templateId || null,
      senderId:   senderId   || creds.senderId,
      companyId,
      campaignId: campaign,
      authKey,
    });
  } catch (err) {
    console.error("sendBulkSms error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// ── POST /api/sms-campaign/send-single ───────────────────────────────────────
const sendSingleSms = async (req, res) => {
  try {
    const { name, mobile, message, templateId, senderId } = req.body;
    if (!mobile || !message) {
      return res.status(400).json({ message: "mobile and message are required" });
    }

    // ── Fetch company SMS credentials from DB ─────────────────────────────
    const companyId = req.admin.company._id;
    const creds     = await getCompanySmsCredentials(companyId);
    const authKey   = creds.authKey;

    if (!authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Go to SMS Settings (gear icon) and save your Auth Key first.",
      });
    }

    const body = message
      .replace(/{{name}}/g,   name   || "")
      .replace(/{{mobile}}/g, mobile || "");

    const requestId = await sendViaMSG91({
      mobile,
      message: body,
      templateId,
      senderId: senderId || creds.senderId,
      authKey,
    });

    await saveLog({
      to:             mobile,
      recipientName:  name || "",
      message:        body,
      templateId,
      senderId:       senderId || creds.senderId,
      campaignId:     null,
      status:         "sent",
      msg91RequestId: String(requestId),
      companyId,
    });

    res.json({ success: true, message: "SMS sent", requestId });
  } catch (err) {
    await saveLog({
      to:            req.body.mobile || "",
      recipientName: req.body.name   || "",
      message:       req.body.message || "",
      campaignId:    null,
      status:        "failed",
      errorMessage:  err.message,
      companyId:     req.admin.company._id,
    });
    res.status(500).json({ message: "Failed to send SMS", error: err.message });
  }
};

// ── POST /api/sms-campaign/send-csv ──────────────────────────────────────────
const sendCsvSms = async (req, res) => {
  try {
    const { recipients, message, templateId, senderId } = req.body;
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: "recipients array is required" });
    }
    if (!message) return res.status(400).json({ message: "message is required" });

    // ── Fetch company SMS credentials from DB ─────────────────────────────
    const companyId = req.admin.company._id;
    const creds     = await getCompanySmsCredentials(companyId);
    const authKey   = creds.authKey;

    if (!authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Go to SMS Settings (gear icon) and save your Auth Key first.",
      });
    }

    res.json({
      success: true,
      message: `SMS blast started for ${recipients.length} CSV recipients`,
      total:   recipients.length,
    });

    runSmsInBackground({
      leads: recipients.map((r) => ({
        name:   r.name   || "",
        mobile: r.mobile,
        email:  "",
      })),
      message,
      templateId: templateId || null,
      senderId:   senderId   || creds.senderId,
      companyId,
      campaignId: "csv-blast",
      authKey,
    });
  } catch (err) {
    console.error("sendCsvSms error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ── GET /api/sms/history ──────────────────────────────────────────────────────
const getSmsHistory = async (req, res) => {
  try {
    const {
      page      = 1,
      limit     = 50,
      search    = "",
      campaignId = "",
      sortOrder = "desc",
      dateFrom  = "",
      dateTo    = "",
    } = req.query;

    const filter = { company: req.admin.company._id };
    if (search)    filter.to         = { $regex: search, $options: "i" };
    if (campaignId) filter.campaignId = campaignId;
    if (dateFrom || dateTo) {
      filter.sentAt = {};
      if (dateFrom) filter.sentAt.$gte = new Date(dateFrom);
      if (dateTo)   filter.sentAt.$lte = new Date(new Date(dateTo).setHours(23, 59, 59, 999));
    }

    const total = await SmsLog.countDocuments(filter);
    const data  = await SmsLog.find(filter)
      .sort({ sentAt: sortOrder === "asc" ? 1 : -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .lean();

    res.json({
      success: true,
      data,
      pagination: {
        page:       +page,
        limit:      +limit,
        total,
        totalPages: Math.ceil(total / +limit),
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch SMS history" });
  }
};

// ── GET /api/sms/history/campaigns ───────────────────────────────────────────
const getSmsCampaigns = async (req, res) => {
  try {
    const campaigns = await SmsLog.distinct("campaignId", {
      company:    req.admin.company._id,
      campaignId: { $ne: null },
    });
    res.json({ success: true, data: campaigns.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch campaigns" });
  }
};

// ── DELETE /api/sms/history/:id ───────────────────────────────────────────────
const deleteSmsLog = async (req, res) => {
  try {
    const log = await SmsLog.findOneAndDelete({
      _id:     req.params.id,
      company: req.admin.company._id,
    });
    if (!log) return res.status(404).json({ message: "Log not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete log" });
  }
};

// ── GET /api/sms-campaign/preview?campaign=XYZ ───────────────────────────────
const previewSmsCampaign = async (req, res) => {
  try {
    const { campaign } = req.query;
    if (!campaign) return res.status(400).json({ message: "campaign is required" });
    const count = await Lead.countDocuments({
      company:  req.admin.company._id,
      campaign,
      mobile:   { $exists: true, $ne: "" },
    });
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ message: "Failed to preview campaign" });
  }
};

module.exports = {
  sendBulkSms,
  sendSingleSms,
  sendCsvSms,
  getSmsHistory,
  getSmsCampaigns,
  deleteSmsLog,
  previewSmsCampaign,
};
