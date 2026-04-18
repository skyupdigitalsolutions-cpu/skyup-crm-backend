const axios = require("axios");
const Lead = require("../models/Leads");

// ── Brevo (Sendinblue) transactional email sender ──────────────────────────────
// Uses Brevo API v3 — no SMTP, no nodemailer, just HTTP POST.
// Set BREVO_API_KEY in your .env

const sendViaBrevo = async ({ to, subject, html, fromName }) => {
  const fromEmail = process.env.BREVO_SENDER_EMAIL;
  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender:      { name: fromName || "CRM", email: fromEmail },
      to,
      subject,
      htmlContent: html,
    },
    {
      headers: {
        "api-key":      process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
    }
  );
};

// ── POST /api/email-campaign/send ─────────────────────────────────────────────
// Body: { campaign, subject, bodyTemplate, fromName? }
// bodyTemplate supports {{name}}, {{campaign}}, {{mobile}}, {{email}} placeholders
const sendBulkEmails = async (req, res) => {
  try {
    const { campaign, subject, bodyTemplate, fromName } = req.body;

    if (!campaign || !subject || !bodyTemplate) {
      return res.status(400).json({ message: "campaign, subject, and bodyTemplate are required" });
    }

    // Fetch all leads that belong to this campaign & have a valid email
    const leads = await Lead.find({
      company:  req.admin.company._id,
      campaign,
      email:    { $exists: true, $ne: "" },
    });

    if (leads.length === 0) {
      return res.status(404).json({ message: "No leads with email found for this campaign" });
    }

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const lead of leads) {
      // Personalise the template
      const html = bodyTemplate
        .replace(/{{name}}/g,     lead.name)
        .replace(/{{campaign}}/g, lead.campaign || "")
        .replace(/{{mobile}}/g,   lead.mobile)
        .replace(/{{email}}/g,    lead.email);

      try {
        await sendViaBrevo({
          to:       [{ email: lead.email, name: lead.name }],
          subject,
          html,
          fromName: fromName || req.admin.company.name || "CRM",
        });
        sent++;
      } catch (err) {
        failed++;
        errors.push({ email: lead.email, error: err?.response?.data?.message || err.message });
      }
    }

    res.json({
      message: `Campaign sent: ${sent} succeeded, ${failed} failed`,
      sent,
      failed,
      total: leads.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error("Email campaign error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ── GET /api/email-campaign/preview ──────────────────────────────────────────
// Query: { campaign } — returns lead count that will receive the email
const previewCampaign = async (req, res) => {
  try {
    const { campaign } = req.query;
    if (!campaign) return res.status(400).json({ message: "campaign is required" });

    const count = await Lead.countDocuments({
      company:  req.admin.company._id,
      campaign,
      email:    { $exists: true, $ne: "" },
    });

    res.json({ campaign, leadCount: count });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ── POST /api/email-campaign/send-single ─────────────────────────────────────
// Body: { name, email, subject, bodyTemplate, fromName? }
const sendSingleEmail = async (req, res) => {
  const { name, email, subject, bodyTemplate, fromName } = req.body;

  if (!email || !subject) {
    return res.status(400).json({ message: "email and subject required" });
  }

  const html = bodyTemplate
    .replace(/{{name}}/g,     name || "Friend")
    .replace(/{{campaign}}/g, "")
    .replace(/{{mobile}}/g,   "")
    .replace(/{{email}}/g,    email);

  try {
    await sendViaBrevo({ to: [{ name, email }], subject, html, fromName });
    res.json({ sent: 1, failed: 0, total: 1 });
  } catch (err) {
    res.json({ sent: 0, failed: 1, total: 1, errors: [{ email, error: err.message }] });
  }
};

// ── POST /api/email-campaign/send-csv ────────────────────────────────────────
// Body: { recipients: [{ name, email }], subject, bodyTemplate, fromName? }
const sendCsvEmails = async (req, res) => {
  const { recipients, subject, bodyTemplate, fromName } = req.body;

  if (!recipients?.length || !subject) {
    return res.status(400).json({ message: "recipients and subject required" });
  }

  let sent = 0, failed = 0;
  const errors = [];

  for (const { name, email } of recipients) {
    const html = bodyTemplate
      .replace(/{{name}}/g,     name || "Friend")
      .replace(/{{campaign}}/g, "")
      .replace(/{{mobile}}/g,   "")
      .replace(/{{email}}/g,    email);

    try {
      await sendViaBrevo({ to: [{ name, email }], subject, html, fromName });
      sent++;
    } catch (err) {
      failed++;
      errors.push({ email, error: err.message });
    }
  }

  res.json({ sent, failed, total: recipients.length, errors });
};

module.exports = { sendBulkEmails, previewCampaign, sendSingleEmail, sendCsvEmails };