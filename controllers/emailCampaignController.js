const axios = require("axios");
const Lead = require("../models/Leads");
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

// ── POST /api/email-campaign/send ─────────────────────────────────────────────
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

    let sent = 0, failed = 0;
    const errors = [];

    for (const lead of leads) {
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
          fromName: fromName || req.admin.company.name || "CRM",
        });
        sent++;
        await saveLog({ to: lead.email, subject, body: html, campaignId: campaign, status: "sent", companyId: req.admin.company._id });
      } catch (err) {
        failed++;
        const errMsg = err?.response?.data?.message || err.message;
        errors.push({ email: lead.email, error: errMsg });
        await saveLog({ to: lead.email, subject, body: html, campaignId: campaign, status: "failed", errorMessage: errMsg, companyId: req.admin.company._id });
      }
    }

    res.json({ message: `Campaign sent: ${sent} succeeded, ${failed} failed`, sent, failed, total: leads.length, errors: errors.length > 0 ? errors : undefined });
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

  let sent = 0, failed = 0;
  const errors = [];

  for (const { name, email } of recipients) {
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
      errors.push({ email, error: err.message });
      await saveLog({ to: email, subject, body: html, campaignId: "csv-import", status: "failed", errorMessage: err.message, companyId: req.admin.company._id });
    }
  }

  res.json({ sent, failed, total: recipients.length, errors });
};

// ── GET /api/email/history ────────────────────────────────────────────────────
const getEmailHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "", campaignId = "", sortOrder = "desc" } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { company: req.admin.company._id };
    if (search.trim()) filter.to = { $regex: search.trim(), $options: "i" };
    if (campaignId.trim()) filter.campaignId = campaignId.trim();

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