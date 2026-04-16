const axios = require("axios");
const Lead = require("../models/Leads");

// ── Brevo (Sendinblue) transactional email sender ──────────────────────────────
// Uses Brevo API v3 — no SMTP, no nodemailer, just HTTP POST.
// Set BREVO_API_KEY in your .env

const sendViaBrevo = async ({ to, toName, subject, htmlContent, fromName, fromEmail }) => {
  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender:      { name: fromName || "CRM", email: fromEmail },
      to:          [{ email: to, name: toName }],
      subject,
      htmlContent,
    },
    {
      headers: {
        "api-key":     process.env.BREVO_API_KEY,
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

    const fromEmail = process.env.BREVO_SENDER_EMAIL; // verified sender in Brevo
    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const lead of leads) {
      // Personalise the template
      const htmlContent = bodyTemplate
        .replace(/{{name}}/g,     lead.name)
        .replace(/{{campaign}}/g, lead.campaign || "")
        .replace(/{{mobile}}/g,   lead.mobile)
        .replace(/{{email}}/g,    lead.email);

      try {
        await sendViaBrevo({
          to:          lead.email,
          toName:      lead.name,
          subject,
          htmlContent,
          fromName:    fromName || req.admin.company.name || "CRM",
          fromEmail,
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
// Body: { campaign } — returns lead count that will receive the email
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

module.exports = { sendBulkEmails, previewCampaign };