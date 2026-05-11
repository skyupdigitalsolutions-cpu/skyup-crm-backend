// controllers/emailCampaignController.js
const axios    = require("axios");
const Lead     = require("../models/Leads");
const EmailLog = require("../models/EmailLog");

// ── Brevo (Sendinblue) transactional email sender ──────────────────────────────
const sendViaBrevo = async ({ to, subject, html, fromName }) => {
  const fromEmail = process.env.BREVO_SENDER_EMAIL;
  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { name: fromName || "CRM", email: fromEmail },
      to,
      subject,
      htmlContent: html,
    },
    {
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
    }
  );
};

// ── Helper: persist an email log entry ────────────────────────────────────────
const saveLog = async ({ to, subject, body, campaignId, status, errorMessage, companyId }) => {
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
// Uses a small concurrency pool (5 at a time) so we don't hammer Brevo.
// ─────────────────────────────────────────────────────────────────────────────
async function runCampaignInBackground({ leads, subject, bodyTemplate, fromName, companyId, companyName, campaignId }) {
  const CONCURRENCY = 5; // max parallel Brevo calls
  let sent = 0, failed = 0;

  // Process leads in chunks of CONCURRENCY
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const chunk = leads.slice(i, i + CONCURRENCY);

    await Promise.all(
      chunk.map(async (lead) => {
        const html = bodyTemplate
          .replace(/{{name}}/g, lead.name)
          .replace(/{{campaign}}/g, lead.campaign || "")
          .replace(/{{mobile}}/g, lead.mobile)
          .replace(/{{email}}/g, lead.email);

        try {
          await sendViaBrevo({
            to: [{ email: lead.email, name: lead.name }],
            subject,
            html,
            fromName: fromName || companyName || "CRM",
          });
          sent++;
          await saveLog({ to: lead.email, subject, body: html, campaignId, status: "sent", companyId });
        } catch (err) {
          failed++;
          const errMsg = err?.response?.data?.message || err.message;
          await saveLog({ to: lead.email, subject, body: html, campaignId, status: "failed", errorMessage: errMsg, companyId });
        }
      })
    );
  }

  console.log(`📧 Campaign "${campaignId}" complete — sent: ${sent}, failed: ${failed}, total: ${leads.length}`);
}

// ── POST /api/email-campaign/send ─────────────────────────────────────────────
// ✅ FIXED: responds immediately with total count, then processes in background.
// Previously this awaited every Brevo call sequentially — with 500 leads the
// request would hang for minutes. Now the HTTP response returns in <100ms.
const sendBulkEmails = async (req, res) => {
  try {
    const { campaign, subject, bodyTemplate, fromName } = req.body;

    if (!campaign || !subject || !bodyTemplate) {
      return res.status(400).json({ message: "campaign, subject, and bodyTemplate are required" });
    }

    const leads = await Lead.find({
      company: req.admin.company._id,
      campaign,
      email: { $exists: true, $ne: "" },
    });

    if (leads.length === 0) {
      return res.status(404).json({ message: "No leads with email found for this campaign" });
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
      companyId:   req.admin.company._id,
      companyName: req.admin.company.name,
      campaignId:  campaign,
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
    if (!campaign) return res.status(400).json({ message: "campaign is required" });
    const count = await Lead.countDocuments({ company: req.admin.company._id, campaign, email: { $exists: true, $ne: "" } });
    res.json({ campaign, leadCount: count });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ── POST /api/email-campaign/send-single ─────────────────────────────────────
const sendSingleEmail = async (req, res) => {
  const { name, email, subject, bodyTemplate, fromName } = req.body;
  if (!email || !subject) return res.status(400).json({ message: "email and subject required" });

  const html = bodyTemplate
    .replace(/{{name}}/g, name || "Friend")
    .replace(/{{campaign}}/g, "")
    .replace(/{{mobile}}/g, "")
    .replace(/{{email}}/g, email);

  try {
    await sendViaBrevo({ to: [{ name, email }], subject, html, fromName });
    await saveLog({ to: email, subject, body: html, campaignId: null, status: "sent", companyId: req.admin.company._id });
    res.json({ sent: 1, failed: 0, total: 1 });
  } catch (err) {
    await saveLog({ to: email, subject, body: html, campaignId: null, status: "failed", errorMessage: err.message, companyId: req.admin.company._id });
    res.json({ sent: 0, failed: 1, total: 1, errors: [{ email, error: err.message }] });
  }
};

// ── POST /api/email-campaign/send-csv ────────────────────────────────────────
const sendCsvEmails = async (req, res) => {
  const { recipients, subject, bodyTemplate, fromName } = req.body;
  if (!recipients?.length || !subject) return res.status(400).json({ message: "recipients and subject required" });

  // Respond immediately for large CSV lists too
  res.json({
    message: `CSV campaign queued — sending to ${recipients.length} recipients in the background.`,
    total: recipients.length,
    queued: true,
  });

  // Process in background with concurrency
  const CONCURRENCY = 5;
  let sent = 0, failed = 0;

  (async () => {
    for (let i = 0; i < recipients.length; i += CONCURRENCY) {
      const chunk = recipients.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ name, email }) => {
          const html = bodyTemplate
            .replace(/{{name}}/g, name || "Friend")
            .replace(/{{campaign}}/g, "")
            .replace(/{{mobile}}/g, "")
            .replace(/{{email}}/g, email);
          try {
            await sendViaBrevo({ to: [{ name, email }], subject, html, fromName });
            sent++;
            await saveLog({ to: email, subject, body: html, campaignId: "csv-import", status: "sent", companyId: req.admin.company._id });
          } catch (err) {
            failed++;
            await saveLog({ to: email, subject, body: html, campaignId: "csv-import", status: "failed", errorMessage: err.message, companyId: req.admin.company._id });
          }
        })
      );
    }
    console.log(`📧 CSV campaign complete — sent: ${sent}, failed: ${failed}, total: ${recipients.length}`);
  })().catch((err) => console.error("CSV campaign background error:", err.message));
};

// ── GET /api/email/history ────────────────────────────────────────────────────
const getEmailHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "", campaignId = "", sortOrder = "desc", dateFrom = "", dateTo = "" } = req.query;
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    const filter = { company: req.admin.company._id };
    if (search.trim()) filter.to = { $regex: search.trim(), $options: "i" };
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
      EmailLog.find(filter).sort({ sentAt: sortDir }).skip(skip).limit(limitNum).select("-body").lean(),
      EmailLog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: logs,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    console.error("getEmailHistory error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ── GET /api/email/history/:id ────────────────────────────────────────────────
const getEmailLogById = async (req, res) => {
  try {
    const log = await EmailLog.findOne({ _id: req.params.id, company: req.admin.company._id }).lean();
    if (!log) return res.status(404).json({ success: false, message: "Log not found" });
    res.json({ success: true, data: log });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ── DELETE /api/email/history/:id ─────────────────────────────────────────────
const deleteEmailLog = async (req, res) => {
  try {
    const log = await EmailLog.findOneAndDelete({ _id: req.params.id, company: req.admin.company._id });
    if (!log) return res.status(404).json({ success: false, message: "Log not found" });
    res.json({ success: true, message: "Log deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ── GET /api/email/history/campaigns ─────────────────────────────────────────
const getDistinctCampaigns = async (req, res) => {
  try {
    const campaigns = await EmailLog.distinct("campaignId", { company: req.admin.company._id, campaignId: { $ne: null } });
    res.json({ success: true, data: campaigns.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = { sendBulkEmails, previewCampaign, sendSingleEmail, sendCsvEmails, getEmailHistory, getEmailLogById, deleteEmailLog, getDistinctCampaigns };