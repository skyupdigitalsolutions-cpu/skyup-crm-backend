// controllers/emailCampaignController.js
//
// EMAIL ROUTING LOGIC (MSG91 → Brevo fallback):
//   1. Try MSG91 Email first IF configured AND daily quota (5000) not exhausted.
//   2. If MSG91 is not configured OR quota is exhausted, fall back to Brevo.
//   3. If neither is available, throw a descriptive error.
//
const { escapeRegex } = require("../utils/escapeRegex");
const axios = require("axios");
const Lead = require("../models/Leads");
const EmailLog = require("../models/EmailLog");
const { getAdminLeadScope, mergeLeadScope } = require("../utils/adminLeadScope");
const Company = require("../models/Company");
const {
  sendViaMsg91Email,
  checkMsg91EmailStatus,
  incrementQuota,
  MSG91_EMAIL_DAILY_LIMIT,
} = require("../utils/msg91Mailer");

// ── Brevo (Sendinblue) transactional email sender ──────────────────────────────
// STRICT company isolation: reads ONLY credentials saved for this company in DB.
// No .env fallback — if a company has not connected Brevo, the call fails with
// a clear message. This prevents one company's Brevo key being used for another.
const sendViaBrevo = async ({ to, toName, subject, html, fromName, companyId }) => {
  if (!companyId) {
    throw new Error("Company ID is required to send email.");
  }

  const company = await Company.findById(companyId)
    .select("+brevoApiKey brevoSenderEmail brevoSenderName")
    .lean();

  const apiKey     = company?.brevoApiKey      || "";
  const fromEmail  = company?.brevoSenderEmail || "";
  const dbFromName = fromName || company?.brevoSenderName || "CRM";

  if (!apiKey || !fromEmail) {
    throw new Error(
      "Email (Brevo) is not connected for your company. " +
      "Go to Communications → Integrations → Email and connect your Brevo account."
    );
  }

  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { name: dbFromName || "CRM", email: fromEmail },
      // Brevo requires `to` to be an array of { email, name } objects — a bare
      // string is rejected with a validation error and the email never sends.
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent: html,
    },
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
    },
  );
};

// ── Smart email sender: MSG91 first → Brevo fallback ──────────────────────────
// Returns the provider used ("msg91" | "brevo") so callers can log it.
// Quota tracking: MSG91 daily counter is incremented after a successful send.
//
// IMPORTANT: This function operates on a SINGLE recipient at a time.
// The batching + quota logic for bulk sends is in runCampaignInBackground().
const sendEmail = async ({ to, toName, subject, html, fromName, companyId, _msg91Status }) => {
  // _msg91Status is pre-fetched by bulk senders so we don't re-query per email.
  const m91 = _msg91Status || (await checkMsg91EmailStatus(companyId));

  if (m91.configured && m91.remaining > 0) {
    // Try MSG91
    try {
      await sendViaMsg91Email({
        to,
        toName,
        subject,
        html,
        fromName,
        company: m91.company,
      });
      return "msg91";
    } catch (err) {
      // MSG91 failed for this specific email — fall through to Brevo
      console.warn(`[emailRouter] MSG91 send failed for ${to}: ${err.message} — falling back to Brevo`);
    }
  } else if (m91.configured && m91.remaining === 0) {
    console.log(`[emailRouter] MSG91 daily limit (${MSG91_EMAIL_DAILY_LIMIT}) reached for company ${companyId} — using Brevo`);
  }

  // Fall back to Brevo
  await sendViaBrevo({ to, toName, subject, html, fromName, companyId });
  return "brevo";
};

// ── Helper: persist an email log entry ────────────────────────────────────────
const saveLog = async ({
  to,
  subject,
  body,
  campaignId,
  status,
  errorMessage,
  companyId,
}) => {
  try {
    await EmailLog.create({
      to,
      subject,
      body,
      campaignId: campaignId || null,
      status,
      errorMessage: errorMessage || null,
      company: companyId,
    });
  } catch (logErr) {
    console.error("EmailLog save failed:", logErr.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal: send all emails in the background (non-blocking).
// Runs AFTER the HTTP response has already been sent to the client.
// Uses a small concurrency pool (5 at a time) so we don't hammer the providers.
//
// QUOTA TRACKING:
//   - Pre-fetch MSG91 status once per campaign run.
//   - Track how many were sent via MSG91 vs Brevo locally.
//   - After each chunk, update the MSG91 daily counter in DB if any went via MSG91.
//   - Once MSG91 quota is exhausted mid-campaign, remaining emails use Brevo.
// ─────────────────────────────────────────────────────────────────────────────
async function runCampaignInBackground({
  leads,
  subject,
  bodyTemplate,
  fromName,
  companyId,
  companyName,
  campaignId,
}) {
  const CONCURRENCY = 5; // max parallel calls
  let sent = 0, failed = 0;
  let msg91SentThisRun = 0;

  // Pre-fetch MSG91 status once (avoids a DB query per email)
  let m91 = await checkMsg91EmailStatus(companyId);

  // Process leads in chunks of CONCURRENCY
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const chunk = leads.slice(i, i + CONCURRENCY);

    // Refresh m91.remaining with locally tracked count so the check is accurate
    // without hitting DB again mid-campaign
    const effectiveM91 = {
      ...m91,
      remaining: Math.max(0, m91.remaining - msg91SentThisRun),
    };

    const results = await Promise.all(
      chunk.map(async (lead) => {
        const html = bodyTemplate
          .replace(/{{name}}/g, lead.name)
          .replace(/{{campaign}}/g, lead.campaign || "")
          .replace(/{{mobile}}/g, lead.mobile)
          .replace(/{{email}}/g, lead.email);

        try {
          const provider = await sendEmail({
            to: lead.email,
            toName: lead.name,
            subject,
            html,
            fromName: fromName || companyName || "CRM",
            companyId,
            _msg91Status: effectiveM91,
          });
          sent++;
          await saveLog({
            to: lead.email,
            subject,
            body: html,
            campaignId,
            status: "sent",
            companyId,
            provider,
          });
          return { via: provider };
        } catch (err) {
          failed++;
          const errMsg = err?.response?.data?.message || err.message;
          await saveLog({
            to: lead.email,
            subject,
            body: html,
            campaignId,
            status: "failed",
            errorMessage: errMsg,
            companyId,
          });
          return { via: null };
        }
      }),
    );

    // Count how many went via MSG91 in this chunk
    const chunkMsg91Count = results.filter((r) => r.via === "msg91").length;
    if (chunkMsg91Count > 0) {
      msg91SentThisRun += chunkMsg91Count;
      // Persist updated counter to DB so other processes / next campaigns see it
      await incrementQuota(companyId, chunkMsg91Count, m91.today, m91.countedToday + msg91SentThisRun - chunkMsg91Count);
    }
  }

  console.log(
    `📧 Campaign "${campaignId}" complete — sent: ${sent}, failed: ${failed}, total: ${leads.length} (MSG91: ${msg91SentThisRun}, Brevo: ${sent - msg91SentThisRun})`,
  );
}

// ── POST /api/email-campaign/send ─────────────────────────────────────────────
// ✅ FIXED: responds immediately with total count, then processes in background.
// Previously this awaited every Brevo call sequentially — with 500 leads the
// request would hang for minutes. Now the HTTP response returns in <100ms.
const sendBulkEmails = async (req, res) => {
  try {
    const { campaign, subject, bodyTemplate, fromName } = req.body;

    if (!campaign || !subject || !bodyTemplate) {
      return res
        .status(400)
        .json({ message: "campaign, subject, and bodyTemplate are required" });
    }

    const emailScope = await getAdminLeadScope(req, req.admin.company._id);
    const leads = await Lead.find(mergeLeadScope({
      company: req.admin.company._id,
      campaign,
      email: { $exists: true, $ne: "" },
    }, emailScope));

    if (leads.length === 0) {
      return res
        .status(404)
        .json({ message: "No leads with email found for this campaign" });
    }

    // ── Respond immediately so the client isn't left waiting ─────────────────
    res.json({
      message: `Campaign queued — sending to ${leads.length} leads in the background.`,
      total: leads.length,
      queued: true,
    });

    // ── Fire-and-forget: process all emails after the response is sent ────────
    runCampaignInBackground({
      leads,
      subject,
      bodyTemplate,
      fromName,
      companyId: req.admin.company._id,
      companyName: req.admin.company.name,
      campaignId: campaign,
    }).catch((err) => {
      console.error("runCampaignInBackground uncaught error:", err.message);
    });
  } catch (err) {
    console.error("Email campaign error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ── GET /api/email-campaign/preview ──────────────────────────────────────────
const previewCampaign = async (req, res) => {
  try {
    const { campaign } = req.query;
    if (!campaign)
      return res.status(400).json({ message: "campaign is required" });
    const previewScope = await getAdminLeadScope(req, req.admin.company._id);
    const count = await Lead.countDocuments(mergeLeadScope({
      company: req.admin.company._id,
      campaign,
      email: { $exists: true, $ne: "" },
    }, previewScope));
    res.json({ campaign, leadCount: count });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ── POST /api/email-campaign/send-single ─────────────────────────────────────
const sendSingleEmail = async (req, res) => {
  const { name, email, subject, bodyTemplate, fromName } = req.body;
  if (!email || !subject)
    return res.status(400).json({ message: "email and subject required" });

  const html = bodyTemplate
    .replace(/{{name}}/g, name || "Friend")
    .replace(/{{campaign}}/g, "")
    .replace(/{{mobile}}/g, "")
    .replace(/{{email}}/g, email);

  try {
    const provider = await sendEmail({
      to: email,
      toName: name,
      subject,
      html,
      fromName,
      companyId: req.admin.company._id,
    });
    // Update MSG91 counter if used
    if (provider === "msg91") {
      const m91 = await checkMsg91EmailStatus(req.admin.company._id);
      await incrementQuota(req.admin.company._id, 1, m91.today, m91.countedToday);
    }
    await saveLog({
      to: email,
      subject,
      body: html,
      campaignId: null,
      status: "sent",
      companyId: req.admin.company._id,
      provider,
    });
    res.json({ sent: 1, failed: 0, total: 1, provider });
  } catch (err) {
    await saveLog({
      to: email,
      subject,
      body: html,
      campaignId: null,
      status: "failed",
      errorMessage: err.message,
      companyId: req.admin.company._id,
    });
    res.json({
      sent: 0,
      failed: 1,
      total: 1,
      errors: [{ email, error: err.message }],
    });
  }
};

// ── POST /api/email-campaign/send-csv ────────────────────────────────────────
const sendCsvEmails = async (req, res) => {
  const { recipients, subject, bodyTemplate, fromName } = req.body;
  if (!recipients?.length || !subject)
    return res.status(400).json({ message: "recipients and subject required" });

  // Respond immediately for large CSV lists too
  res.json({
    message: `CSV campaign queued — sending to ${recipients.length} recipients in the background.`,
    total: recipients.length,
    queued: true,
  });

  // Process in background with concurrency + MSG91→Brevo fallback
  const CONCURRENCY = 5;
  let sent = 0, failed = 0, msg91SentThisRun = 0;
  const companyId = req.admin.company._id;

  (async () => {
    let m91 = await checkMsg91EmailStatus(companyId);

    for (let i = 0; i < recipients.length; i += CONCURRENCY) {
      const chunk = recipients.slice(i, i + CONCURRENCY);
      const effectiveM91 = {
        ...m91,
        remaining: Math.max(0, m91.remaining - msg91SentThisRun),
      };

      const results = await Promise.all(
        chunk.map(async ({ name, email }) => {
          const html = bodyTemplate
            .replace(/{{name}}/g, name || "Friend")
            .replace(/{{campaign}}/g, "")
            .replace(/{{mobile}}/g, "")
            .replace(/{{email}}/g, email);
          try {
            const provider = await sendEmail({
              to: email,
              toName: name,
              subject,
              html,
              fromName,
              companyId,
              _msg91Status: effectiveM91,
            });
            sent++;
            await saveLog({ to: email, subject, body: html, campaignId: "csv-import", status: "sent", companyId, provider });
            return { via: provider };
          } catch (err) {
            failed++;
            await saveLog({ to: email, subject, body: html, campaignId: "csv-import", status: "failed", errorMessage: err.message, companyId });
            return { via: null };
          }
        }),
      );

      const chunkMsg91Count = results.filter((r) => r.via === "msg91").length;
      if (chunkMsg91Count > 0) {
        msg91SentThisRun += chunkMsg91Count;
        await incrementQuota(companyId, chunkMsg91Count, m91.today, m91.countedToday + msg91SentThisRun - chunkMsg91Count);
      }
    }
    console.log(
      `📧 CSV campaign complete — sent: ${sent}, failed: ${failed}, total: ${recipients.length} (MSG91: ${msg91SentThisRun}, Brevo: ${sent - msg91SentThisRun})`,
    );
  })().catch((err) =>
    console.error("CSV campaign background error:", err.message),
  );
};

// ── GET /api/email/history ────────────────────────────────────────────────────
const getEmailHistory = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      campaignId = "",
      sortOrder = "desc",
      dateFrom = "",
      dateTo = "",
    } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { company: req.admin.company._id };
    if (search.trim()) filter.to = { $regex: escapeRegex(search.trim()), $options: "i" }; // A.8.28 literal match
    if (campaignId.trim()) filter.campaignId = campaignId.trim();

    // Date range filter on sentAt
    if (dateFrom.trim() || dateTo.trim()) {
      filter.sentAt = {};
      if (dateFrom.trim()) {
        filter.sentAt.$gte = new Date(dateFrom.trim());
      }
      if (dateTo.trim()) {
        const endDate = new Date(dateTo.trim());
        endDate.setHours(23, 59, 59, 999);
        filter.sentAt.$lte = endDate;
      }
    }

    const sortDir = sortOrder === "asc" ? 1 : -1;
    const [logs, total] = await Promise.all([
      EmailLog.find(filter)
        .sort({ sentAt: sortDir })
        .skip(skip)
        .limit(limitNum)
        .select("-body")
        .lean(),
      EmailLog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error("getEmailHistory error:", err);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ── GET /api/email/history/:id ────────────────────────────────────────────────
const getEmailLogById = async (req, res) => {
  try {
    const log = await EmailLog.findOne({
      _id: req.params.id,
      company: req.admin.company._id,
    }).lean();
    if (!log)
      return res.status(404).json({ success: false, message: "Log not found" });
    res.json({ success: true, data: log });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ── DELETE /api/email/history/:id ─────────────────────────────────────────────
const deleteEmailLog = async (req, res) => {
  try {
    const log = await EmailLog.findOneAndDelete({
      _id: req.params.id,
      company: req.admin.company._id,
    });
    if (!log)
      return res.status(404).json({ success: false, message: "Log not found" });
    res.json({ success: true, message: "Log deleted" });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// ── GET /api/email/history/campaigns ─────────────────────────────────────────
const getDistinctCampaigns = async (req, res) => {
  try {
    const campaigns = await EmailLog.distinct("campaignId", {
      company: req.admin.company._id,
      campaignId: { $ne: null },
    });
    res.json({ success: true, data: campaigns.filter(Boolean) });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

// GET /api/email-campaign/brevo-status
const getBrevoStatus = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    // Check your existing email config model / Company model for brevoApiKey
    const company = await Company.findById(companyId).select("brevoApiKey").lean();
    res.json({ connected: !!(company?.brevoApiKey) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/email-campaign/msg91-email-status
const getMsg91EmailStatus = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { configured, remaining, company } = await checkMsg91EmailStatus(companyId);
    res.json({
      connected: configured,
      remaining,
      dailyLimit: MSG91_EMAIL_DAILY_LIMIT,
      senderEmail: company?.msg91EmailSenderEmail || "",
      domain: company?.msg91EmailDomain || "",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  sendBulkEmails,
  previewCampaign,
  sendSingleEmail,
  sendCsvEmails,
  getEmailHistory,
  getEmailLogById,
  deleteEmailLog,
  getDistinctCampaigns,
  getBrevoStatus,
  getMsg91EmailStatus,
};