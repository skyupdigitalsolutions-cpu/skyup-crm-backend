// controllers/smsCampaignController.js
// SMS Blasting via MSG91 — supports campaign (CRM leads), single, and CSV modes.
// MSG91 SMS API: https://docs.msg91.com/reference/send-sms
//
// Auth Key is read from SmsConfig (DB, per-company).

const { escapeRegex } = require("../utils/escapeRegex");
const axios     = require("axios");
const Lead      = require("../models/Leads");
const SmsLog    = require("../models/SmsLog");
const { getAdminLeadScope, mergeLeadScope } = require("../utils/adminLeadScope");
const SmsConfig = require("../models/SmsConfig");

// ── Helper: get auth key + sender ID for a company ───────────────────────────
async function getCompanySmsCredentials(companyId) {
  const config = await SmsConfig.findOne({ company: companyId });
  return {
    authKey:             config?.msg91AuthKey          || "",
    senderId:            config?.msg91SenderId         || "SKYCRM",
    greetingsTemplateId: config?.greetingsTemplateId   || "1007503933418344595",
    greetingsSenderId:   config?.greetingsSenderId     || "695382",
  };
}

// ── MSG91 SMS sender ──────────────────────────────────────────────────────────
// Uses the current MSG91 v5/flow endpoint (textsms/send was deprecated → 404).
// Docs: https://docs.msg91.com/reference/send-sms
//
// Endpoint: POST https://control.msg91.com/api/v5/flow
// Payload : { template_id, short_url, recipients: [{ mobiles, VAR1, ... }] }
//
// The template_id must be a DLT-approved SMS template ID from your MSG91
// dashboard (SMS → Templates). Free-text messages are no longer supported
// by this endpoint — every SMS must use a registered template.
const sendViaMSG91 = async ({ mobile, name, templateId, senderId, authKey }) => {
  if (!authKey) {
    throw new Error(
      "MSG91 Auth Key not configured. Go to SMS Settings (gear icon) and save your Auth Key."
    );
  }

  if (!templateId) {
    throw new Error(
      "MSG91 template_id is required. Go to SMS Settings and enter your DLT-approved MSG91 Template ID."
    );
  }

  // Normalize: strip all non-digits
  // - 10-digit bare number → prepend India country code 91
  // - 11–13 digit number   → already has a country code, keep as-is
  // - Do NOT slice — trimming drops valid leading country-code digits
  let phone = mobile.replace(/\D/g, "");
  if (phone.startsWith("0091")) phone = phone.slice(4);
  if (phone.startsWith("00"))   phone = phone.slice(2);
  if (phone.length === 10)      phone = "91" + phone;

  // MSG91 v5/flow payload for DLT template "Skyup_greetings":
  //   "Hi ##alphanumeric##, thank you for contacting SKYUP Digital Solutions LLP!..."
  //
  // IMPORTANT: field name is 'flow_id' NOT 'template_id' for the /api/v5/flow/ endpoint.
  // MSG91 docs: "Copy the template ID and use it as Flow_ID"
  // Ref: https://control.msg91.com/api/v5/flow/
  const payload = {
    flow_id:   templateId,            // ✅ correct field name (not template_id)
    sender:    senderId || "695382",  // DLT Sender ID for Skyup_greetings
    short_url: "0",
    route:     "1",  // ✅ Promotional route (was "4" transactional — caused all SMS to fail)
    mobiles:   phone,
    VAR1:      name || "there",       // fills ##alphanumeric## slot in the DLT template
  };

  let data;
  try {
    const response = await axios.post(
      "https://control.msg91.com/api/v5/flow/",   // ✅ correct current endpoint (trailing slash required)
      payload,
      {
        headers: {
          authkey:        authKey,
          "Content-Type": "application/json",
          accept:         "application/json",
        },
        timeout: 15000,
      }
    );
    data = response.data;
  } catch (axiosErr) {
    // Surface the actual MSG91 error body if present
    const msg91Msg = axiosErr.response?.data?.message
      || axiosErr.response?.data?.error
      || axiosErr.message;
    throw new Error(`MSG91 request failed: ${msg91Msg}`);
  }

  // MSG91 returns { type: "success", message: "..." } on success
  if (
    data?.type === "error" ||
    (typeof data === "string" && data.toLowerCase().startsWith("error"))
  ) {
    throw new Error(`MSG91 error: ${data?.message || data}`);
  }

  return data?.message || data?.request_id || data?.requestId || "sent";
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
  authKey,
}) {
  const CONCURRENCY = 5;
  let sent = 0, failed = 0;

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const chunk = leads.slice(i, i + CONCURRENCY);

    await Promise.all(
      chunk.map(async (lead) => {
        // Merge-tag substitution: ##alphanumeric## maps to {{name}}
        const body = message
          .replace(/{{name}}/g,     lead.name     || "")
          .replace(/{{mobile}}/g,   lead.mobile   || "")
          .replace(/{{email}}/g,    lead.email    || "")
          .replace(/{{campaign}}/g, lead.campaign || "");

        try {
          const requestId = await sendViaMSG91({
            mobile:     lead.mobile,
            name:       lead.name || "there",   // VAR1 = name fills ##alphanumeric## slot
            templateId,
            senderId,
            authKey,
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

    const companyId = req.admin.company._id;
    const creds     = await getCompanySmsCredentials(companyId);
    const authKey   = creds.authKey;

    if (!authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Go to SMS Settings and save your Auth Key first.",
      });
    }

    const smsScope = await getAdminLeadScope(req, companyId);
    const leads = await Lead.find(mergeLeadScope({
      company: companyId,
      campaign,
      mobile: { $exists: true, $ne: "" },
    }, smsScope))
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

    const companyId = req.admin.company._id;
    const creds     = await getCompanySmsCredentials(companyId);
    const authKey   = creds.authKey;

    if (!authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Go to SMS Settings and save your Auth Key first.",
      });
    }

    // Use templateId from request body, fallback to company's saved greetingsTemplateId
    const resolvedTemplateId = templateId || creds.greetingsTemplateId;

    const requestId = await sendViaMSG91({
      mobile,
      name:       name || "there",   // VAR1 = name fills ##alphanumeric## in DLT template
      templateId: resolvedTemplateId,
      senderId:   senderId || creds.senderId,
      authKey,
    });

    // Log the actual template message text for records
    const logMessage = `Hi ${name || "there"}, thank you for contacting SKYUP Digital Solutions LLP! Our Services:SEO Services, Social Media & GBP Management, Google & Meta Ads, Website Design & Development, AI Automation & Machine Learning, Chatbot & WhatsApp Automation. One of our team members will connect with you shortly. Phone: +91 88678 67775 Website: SKYUP Digital Solutions LLP`;

    await saveLog({
      to:             mobile,
      recipientName:  name || "",
      message:        logMessage,
      templateId:     resolvedTemplateId,
      senderId:       senderId || creds.senderId,
      campaignId:     null,
      status:         "sent",
      msg91RequestId: String(requestId),
      companyId,
    });

    res.json({ success: true, message: "SMS sent", requestId });
  } catch (err) {
    await saveLog({
      to:            req.body.mobile  || "",
      recipientName: req.body.name    || "",
      message:       req.body.message || "",
      campaignId:    null,
      status:        "failed",
      errorMessage:  err.message,
      companyId:     req.admin.company._id,
    });
    res.status(500).json({ message: err.message, error: err.message });
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

    const companyId = req.admin.company._id;
    const creds     = await getCompanySmsCredentials(companyId);
    const authKey   = creds.authKey;

    if (!authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Go to SMS Settings and save your Auth Key first.",
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
      page       = 1,
      limit      = 50,
      search     = "",
      campaignId = "",
      sortOrder  = "desc",
      dateFrom   = "",
      dateTo     = "",
    } = req.query;

    const filter = { company: req.admin.company._id };
    if (search)     filter.to         = { $regex: escapeRegex(search), $options: "i" }; // A.8.28 literal match
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
    const previewScope = await getAdminLeadScope(req, req.admin.company._id);
    const count = await Lead.countDocuments(mergeLeadScope({
      company:  req.admin.company._id,
      campaign,
      mobile:   { $exists: true, $ne: "" },
    }, previewScope));
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ message: "Failed to preview campaign" });
  }
};

// (exports moved to bottom)

// ═══════════════════════════════════════════════════════════════════════════════
// EMPLOYEE-FACING SMS ROUTES (use `protect` middleware, not `protectAdmin`)
// These mirror the admin routes but are scoped to the employee's assigned leads.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helper: get companyId from employee req ───────────────────────────────────
function getEmployeeCompanyId(req) {
  return req.user?.company?._id || req.user?.company || req.user?.companyId;
}

// ── GET /api/sms-campaign/employee/preview?campaign=XYZ ──────────────────────
// Returns count of the employee's assigned leads in that campaign with a mobile.
const employeePreviewSmsCampaign = async (req, res) => {
  try {
    const { campaign } = req.query;
    if (!campaign) return res.status(400).json({ message: "campaign is required" });

    const companyId = getEmployeeCompanyId(req);
    const userId    = req.user._id;

    const filter = {
      company:  companyId,
      user:     userId,
      mobile:   { $exists: true, $ne: "" },
    };
    if (campaign !== "__all__") filter.campaign = campaign;

    const count = await Lead.countDocuments(filter);
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ message: "Failed to preview campaign" });
  }
};

// ── GET /api/sms-campaign/employee/my-campaigns ───────────────────────────────
// Distinct campaign names from the employee's assigned leads.
const employeeGetMyCampaigns = async (req, res) => {
  try {
    const companyId = getEmployeeCompanyId(req);
    const userId    = req.user._id;

    const campaigns = await Lead.distinct("campaign", {
      company:  companyId,
      user:     userId,
      campaign: { $nin: [null, ""] },
      mobile:   { $exists: true, $ne: "" },
    });

    res.json({ success: true, data: campaigns.filter(Boolean).sort() });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch your campaigns" });
  }
};

// ── POST /api/sms-campaign/employee/send ─────────────────────────────────────
// Blast SMS to all the employee's assigned leads (optionally filtered by campaign).
const employeeSendBulkSms = async (req, res) => {
  try {
    const { campaign, message, templateId, senderId } = req.body;
    if (!message) return res.status(400).json({ message: "message is required" });

    const companyId = getEmployeeCompanyId(req);
    const userId    = req.user._id;
    const creds     = await getCompanySmsCredentials(companyId);

    if (!creds.authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Ask your admin to set it up in SMS Settings.",
      });
    }

    const filter = {
      company: companyId,
      user:    userId,
      mobile:  { $exists: true, $ne: "" },
    };
    if (campaign && campaign !== "__all__") filter.campaign = campaign;

    const leads = await Lead.find(filter)
      .select("name mobile email campaign")
      .lean();

    if (leads.length === 0) {
      return res.status(404).json({
        message: campaign
          ? `No leads with mobile numbers found in campaign "${campaign}"`
          : "No assigned leads with mobile numbers found",
      });
    }

    res.json({
      success: true,
      message: `SMS blast started for ${leads.length} leads`,
      total:   leads.length,
    });

    runSmsInBackground({
      leads,
      message,
      templateId: templateId || null,
      senderId:   senderId   || creds.senderId,
      companyId,
      campaignId: campaign   || "employee-blast",
      authKey:    creds.authKey,
    });
  } catch (err) {
    console.error("employeeSendBulkSms error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

// ── POST /api/sms-campaign/employee/send-single ───────────────────────────────
const employeeSendSingleSms = async (req, res) => {
  try {
    const { name, mobile, message, templateId, senderId } = req.body;
    if (!mobile || !message) {
      return res.status(400).json({ message: "mobile and message are required" });
    }

    const companyId = getEmployeeCompanyId(req);
    const creds     = await getCompanySmsCredentials(companyId);

    if (!creds.authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Ask your admin to configure it.",
      });
    }

    const resolvedTemplateId = templateId || creds.greetingsTemplateId;

    const requestId = await sendViaMSG91({
      mobile,
      name:       name || "there",
      templateId: resolvedTemplateId,
      senderId:   senderId || creds.senderId,
      authKey:    creds.authKey,
    });

    const logMessage = message
      .replace(/{{name}}/g,     name     || "")
      .replace(/{{mobile}}/g,   mobile   || "")
      .replace(/{{campaign}}/g, "")
      .replace(/{{email}}/g,    "");

    await saveLog({
      to:             mobile,
      recipientName:  name || "",
      message:        logMessage,
      templateId:     resolvedTemplateId,
      senderId:       senderId || creds.senderId,
      campaignId:     null,
      status:         "sent",
      msg91RequestId: String(requestId),
      companyId,
    });

    res.json({ success: true, message: "SMS sent", requestId });
  } catch (err) {
    await saveLog({
      to:            req.body.mobile  || "",
      recipientName: req.body.name    || "",
      message:       req.body.message || "",
      campaignId:    null,
      status:        "failed",
      errorMessage:  err.message,
      companyId:     getEmployeeCompanyId(req),
    });
    res.status(500).json({ message: err.message, error: err.message });
  }
};

// ── POST /api/sms-campaign/employee/send-csv ─────────────────────────────────
const employeeSendCsvSms = async (req, res) => {
  try {
    const { recipients, message, templateId, senderId } = req.body;
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: "recipients array is required" });
    }
    if (!message) return res.status(400).json({ message: "message is required" });

    const companyId = getEmployeeCompanyId(req);
    const creds     = await getCompanySmsCredentials(companyId);

    if (!creds.authKey) {
      return res.status(400).json({
        message: "MSG91 Auth Key not configured. Ask your admin to configure it.",
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
      campaignId: "employee-csv-blast",
      authKey:    creds.authKey,
    });
  } catch (err) {
    console.error("employeeSendCsvSms error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ── GET /api/sms-config/employee ──────────────────────────────────────────────
// Read-only view of SMS config (auth key masked) for the employee panel.
const employeeGetSmsConfig = async (req, res) => {
  try {
    const companyId = getEmployeeCompanyId(req);
    const config    = await SmsConfig.findOne({ company: companyId });
    res.json({
      success: true,
      data: {
        msg91SenderId:       config?.msg91SenderId         || "SKYCRM",
        greetingsTemplateId: config?.greetingsTemplateId   || "1007503933418344595",
        greetingsSenderId:   config?.greetingsSenderId     || "695382",
        isConfigured:        !!(config?.msg91AuthKey),
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch SMS config" });
  }
};

// ── GET /api/sms-campaign/employee/thread?mobile=XXXXX ────────────────────────
// Returns all SMS logs sent to a specific mobile number, scoped to employee's company.
// Used by the SMS Direct Messaging tab to show a conversation-style thread.
const employeeGetSmsThread = async (req, res) => {
  try {
    const { mobile } = req.query;
    if (!mobile) return res.status(400).json({ message: "mobile is required" });

    const companyId = getEmployeeCompanyId(req);

    // Normalize: keep last 10 digits for matching
    const digits = String(mobile).replace(/\D/g, "");
    const last10 = digits.slice(-10);

    // Match both 10-digit and 12-digit formats (e.g. 9876543210 or 919876543210)
    const logs = await SmsLog.find({
      company: companyId,
      to: { $regex: last10 + "$" },
    })
      .sort({ sentAt: 1 })
      .limit(100)
      .lean();

    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch SMS thread" });
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
  // employee exports
  employeePreviewSmsCampaign,
  employeeGetMyCampaigns,
  employeeSendBulkSms,
  employeeSendSingleSms,
  employeeSendCsvSms,
  employeeGetSmsConfig,
  employeeGetSmsThread,
};