// controllers/smsCampaignController.js
// SMS Blasting via MSG91 — supports campaign (CRM leads), single, and CSV modes.
// MSG91 API docs: https://docs.msg91.com/reference/send-sms

const axios  = require("axios");
const Lead   = require("../models/Leads");
const SmsLog = require("../models/SmsLog");

// ── MSG91 SMS sender ──────────────────────────────────────────────────────────
// Sends a single SMS to one mobile number via MSG91 Flow/OTP API.
// MSG91 requires DLT-registered template IDs for Indian numbers.
const sendViaMSG91 = async ({ mobile, message, templateId, senderId }) => {
  const authKey = process.env.MSG91_AUTH_KEY;
  if (!authKey) throw new Error("MSG91_AUTH_KEY not configured in environment");

  // Normalize to 10-digit or country-prefixed
  const phone = mobile.replace(/\D/g, "");

  const payload = {
    sender:     senderId || process.env.MSG91_SENDER_ID || "SKYCRM",
    route:      "4", // transactional route
    country:    "91",
    sms: [
      {
        message,
        to: [phone],
      },
    ],
  };

  // If a DLT template_id is provided, attach it
  if (templateId) payload.template_id = templateId;

  const { data } = await axios.post(
    "https://api.msg91.com/api/sendhttp.php",
    null, // GET-style params
    {
      params: {
        authkey:     authKey,
        mobiles:     phone,
        message,
        sender:      senderId || process.env.MSG91_SENDER_ID || "SKYCRM",
        route:       "4",
        country:     "91",
        ...(templateId ? { template_id: templateId } : {}),
      },
    }
  );

  // MSG91 returns a string like "1234567890abcdef" on success or "ERROR..." on failure
  if (typeof data === "string" && data.toLowerCase().startsWith("error")) {
    throw new Error(`MSG91 error: ${data}`);
  }

  return data; // requestId string
};

// ── Helper: persist an SMS log ────────────────────────────────────────────────
const saveLog = async ({
  to, recipientName, message, templateId, senderId, campaignId,
  status, errorMessage, msg91RequestId, companyId,
}) => {
  try {
    await SmsLog.create({
      to, recipientName, message, templateId, senderId, campaignId,
      status, errorMessage: errorMessage || null,
      msg91RequestId: msg91RequestId || null,
      company: companyId,
    });
  } catch (err) {
    console.error("SmsLog save failed:", err.message);
  }
};

// ── Background bulk sender (non-blocking) ─────────────────────────────────────
async function runSmsInBackground({
  leads, message, templateId, senderId, companyId, campaignId,
}) {
  const CONCURRENCY = 5;
  let sent = 0, failed = 0;

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const chunk = leads.slice(i, i + CONCURRENCY);

    await Promise.all(
      chunk.map(async (lead) => {
        // Merge-tag substitution
        const body = message
          .replace(/{{name}}/g, lead.name || "")
          .replace(/{{mobile}}/g, lead.mobile || "")
          .replace(/{{email}}/g, lead.email || "")
          .replace(/{{campaign}}/g, lead.campaign || "");

        try {
          const requestId = await sendViaMSG91({
            mobile: lead.mobile,
            message: body,
            templateId,
            senderId,
          });
          sent++;
          await saveLog({
            to: lead.mobile, recipientName: lead.name, message: body,
            templateId, senderId, campaignId,
            status: "sent", msg91RequestId: String(requestId), companyId,
          });
        } catch (err) {
          failed++;
          await saveLog({
            to: lead.mobile, recipientName: lead.name, message: body,
            templateId, senderId, campaignId,
            status: "failed", errorMessage: err.message, companyId,
          });
        }
      })
    );
  }

  console.log(
    `📱 SMS Campaign "${campaignId}" complete — sent: ${sent}, failed: ${failed}, total: ${leads.length}`
  );
}

// ── POST /api/sms-campaign/send ───────────────────────────────────────────────
// Send SMS to all leads in a CRM campaign group
const sendBulkSms = async (req, res) => {
  try {
    const { campaign, message, templateId, senderId } = req.body;

    if (!campaign || !message) {
      return res.status(400).json({ message: "campaign and message are required" });
    }

    const leads = await Lead.find({
      company: req.admin.company._id,
      campaign,
      mobile: { $exists: true, $ne: "" },
    }).select("name mobile email campaign").lean();

    if (leads.length === 0) {
      return res.status(404).json({ message: `No leads with mobile numbers found in campaign "${campaign}"` });
    }

    // Respond immediately — send in background
    res.json({
      success: true,
      message: `SMS blast started for ${leads.length} leads in "${campaign}"`,
      total: leads.length,
    });

    runSmsInBackground({
      leads,
      message,
      templateId: templateId || null,
      senderId:   senderId   || null,
      companyId:  req.admin.company._id,
      campaignId: campaign,
    });
  } catch (err) {
    console.error("sendBulkSms error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// ── POST /api/sms-campaign/send-single ───────────────────────────────────────
// Send one SMS to a specific mobile number
const sendSingleSms = async (req, res) => {
  try {
    const { name, mobile, message, templateId, senderId } = req.body;

    if (!mobile || !message) {
      return res.status(400).json({ message: "mobile and message are required" });
    }

    const body = message
      .replace(/{{name}}/g, name || "")
      .replace(/{{mobile}}/g, mobile || "");

    const requestId = await sendViaMSG91({ mobile, message: body, templateId, senderId });

    await saveLog({
      to: mobile, recipientName: name || "", message: body,
      templateId, senderId, campaignId: null,
      status: "sent", msg91RequestId: String(requestId),
      companyId: req.admin.company._id,
    });

    res.json({ success: true, message: "SMS sent", requestId });
  } catch (err) {
    await saveLog({
      to: req.body.mobile || "", recipientName: req.body.name || "",
      message: req.body.message || "", campaignId: null,
      status: "failed", errorMessage: err.message,
      companyId: req.admin.company._id,
    });
    res.status(500).json({ message: "Failed to send SMS", error: err.message });
  }
};

// ── POST /api/sms-campaign/send-csv ──────────────────────────────────────────
// Send SMS to an ad-hoc list of {name, mobile} pairs from CSV
const sendCsvSms = async (req, res) => {
  try {
    const { recipients, message, templateId, senderId } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: "recipients array is required" });
    }
    if (!message) {
      return res.status(400).json({ message: "message is required" });
    }

    res.json({
      success: true,
      message: `SMS blast started for ${recipients.length} CSV recipients`,
      total: recipients.length,
    });

    runSmsInBackground({
      leads:      recipients.map((r) => ({ name: r.name || "", mobile: r.mobile, email: "" })),
      message,
      templateId: templateId || null,
      senderId:   senderId   || null,
      companyId:  req.admin.company._id,
      campaignId: "csv-blast",
    });
  } catch (err) {
    console.error("sendCsvSms error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ── GET /api/sms/history ──────────────────────────────────────────────────────
// Paginated SMS log history with search / filter
const getSmsHistory = async (req, res) => {
  try {
    const {
      page = 1, limit = 50,
      search = "", campaignId = "",
      sortOrder = "desc",
      dateFrom = "", dateTo = "",
    } = req.query;

    const filter = { company: req.admin.company._id };
    if (search)     filter.to = { $regex: search, $options: "i" };
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
        page: +page,
        limit: +limit,
        total,
        totalPages: Math.ceil(total / +limit),
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch SMS history" });
  }
};

// ── GET /api/sms/history/campaigns ───────────────────────────────────────────
// Returns distinct campaign names for filter dropdown
const getSmsCampaigns = async (req, res) => {
  try {
    const campaigns = await SmsLog.distinct("campaignId", {
      company: req.admin.company._id,
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
      _id: req.params.id,
      company: req.admin.company._id,
    });
    if (!log) return res.status(404).json({ message: "Log not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete log" });
  }
};

// ── GET /api/sms-campaign/preview?campaign=XYZ ───────────────────────────────
// Preview lead count for a campaign (reuses same query as sendBulkSms)
const previewSmsCampaign = async (req, res) => {
  try {
    const { campaign } = req.query;
    if (!campaign) return res.status(400).json({ message: "campaign is required" });

    const count = await Lead.countDocuments({
      company: req.admin.company._id,
      campaign,
      mobile: { $exists: true, $ne: "" },
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