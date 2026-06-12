// services/autoTemplateService.js
//
// Sends WhatsApp, Email, and SMS automatically to:
//   1. New leads (autoSendTemplates)  — triggered on lead creation
//   2. Interested leads (sendInterestedBlast) — triggered when status → "Interested"
//
// Email routing: MSG91 first (if configured) → Brevo fallback

"use strict";

const axios          = require("axios");
const Company        = require("../models/Company");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const SmsConfig      = require("../models/SmsConfig");
const EmailLog       = require("../models/EmailLog");
const SmsLog         = require("../models/SmsLog");

const {
  sendViaMsg91Email,
  checkMsg91EmailStatus,
  incrementQuota,
} = require("../utils/msg91Mailer");

// ─── Normalise phone to full E.164 digits (no +) ────────────────────────────
function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.startsWith("00"))   digits = digits.slice(2);
  if (digits.startsWith("0"))    digits = digits.slice(1);
  if (digits.length === 10)      digits = "91" + digits;
  return digits;
}

// ─── Shared: Smart Email — MSG91 first → Brevo fallback ─────────────────────
// Returns the provider used: "msg91" | "brevo"
async function sendSmartEmail({ to, toName, subject, html, fromName, companyId }) {
  // Try MSG91 Email if configured and quota available
  const m91 = await checkMsg91EmailStatus(companyId);
  if (m91.configured && m91.remaining > 0) {
    try {
      await sendViaMsg91Email({ to, toName, subject, html, fromName, company: m91.company });
      await incrementQuota(companyId, 1, m91.today, m91.countedToday);
      return "msg91";
    } catch (err) {
      console.warn(`[autoTemplate] MSG91 email failed for ${to}: ${err.message} — falling back to Brevo`);
    }
  } else if (m91.configured && m91.remaining === 0) {
    console.log(`[autoTemplate] MSG91 daily limit reached for company ${companyId} — using Brevo`);
  }

  // Fall back to Brevo
  const company = await Company.findById(companyId)
    .select("+brevoApiKey brevoSenderEmail brevoSenderName")
    .lean();

  const apiKey    = company?.brevoApiKey      || "";
  const fromEmail = company?.brevoSenderEmail || "";
  const sender    = fromName || company?.brevoSenderName || "CRM";

  if (!apiKey || !fromEmail) {
    throw new Error(
      "Neither MSG91 Email nor Brevo is configured for this company. " +
      "Go to Communications → Integrations → Email to connect one."
    );
  }

  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender:      { name: sender, email: fromEmail },
      to:          [{ email: to, name: toName || to }],
      subject,
      htmlContent: html,
    },
    { headers: { "api-key": apiKey, "Content-Type": "application/json" } }
  );
  return "brevo";
}

// ─── 1. WhatsApp ─────────────────────────────────────────────────────────────
async function sendAutoWhatsApp({ companyId, lead, whatsappSettings }) {
  const { templateName = "crm_followup_leads", languageCode = "en" } = whatsappSettings;

  console.log(`[autoTemplate] WA → looking up WhatsAppConfig for company ${companyId}`);

  const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true }).lean();
  if (!config) {
    console.warn(`[autoTemplate] ❌ WA skipped — no active WhatsAppConfig found for company ${companyId}`);
    return;
  }

  const provider     = config.provider || "msg91";
  const authKey      = config.msg91AuthKey      || "";
  const senderNumber = config.msg91IntegratedNumber || "";
  const cleanPhone   = normalizePhone(lead.mobile);

  if (!cleanPhone || cleanPhone.length < 10) {
    console.warn(`[autoTemplate] ❌ WA skipped — invalid phone: "${cleanPhone}"`);
    return;
  }

  if (provider === "msg91") {
    if (!authKey || !senderNumber) {
      console.warn(`[autoTemplate] ❌ WA skipped — MSG91 credentials missing`);
      return;
    }

    const namespace  = config.msg91Namespace || "";
    const components = (lead.name || "").trim()
      ? { body_customer_name: { type: "text", value: lead.name.trim(), parameter_name: "customer_name" } }
      : {};

    const templateBlock = {
      name:              templateName.trim(),
      language:          { code: languageCode || "en", policy: "deterministic" },
      to_and_components: [{ to: [cleanPhone], components }],
    };
    if (namespace) templateBlock.namespace = namespace;

    const requestPayload = {
      integrated_number: senderNumber,
      content_type:      "template",
      payload: {
        messaging_product: "whatsapp",
        type:              "template",
        template:          templateBlock,
      },
    };

    console.log(`[autoTemplate] 📤 WA MSG91 → phone=${cleanPhone} template="${templateName}"`);
    try {
      const resp = await axios.post(
        "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
        requestPayload,
        { headers: { authkey: authKey, "Content-Type": "application/json" } }
      );
      console.log(`[autoTemplate] ✅ WA sent:`, JSON.stringify(resp.data));
    } catch (err) {
      console.error(`[autoTemplate] ❌ WA error:`, JSON.stringify(err?.response?.data || err.message));
      throw err;
    }

  } else {
    if (!config.phoneNumberId || !config.accessToken) {
      console.warn(`[autoTemplate] ❌ WA skipped — Meta credentials missing`);
      return;
    }
    const apiUrl = `https://graph.facebook.com/${config.graphApiVersion || "v21.0"}/${config.phoneNumberId}/messages`;
    const metaPayload = {
      messaging_product: "whatsapp",
      to:   cleanPhone,
      type: "template",
      template: { name: templateName.trim(), language: { code: languageCode || "en" } },
    };
    try {
      const resp = await axios.post(apiUrl, metaPayload, {
        headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      });
      console.log(`[autoTemplate] ✅ WA Meta sent:`, JSON.stringify(resp.data));
    } catch (err) {
      console.error(`[autoTemplate] ❌ WA Meta error:`, JSON.stringify(err?.response?.data || err.message));
      throw err;
    }
  }
}

// ─── 2. Email (MSG91 → Brevo) ─────────────────────────────────────────────────
// FIX: now uses MSG91 email first (if configured), then falls back to Brevo
async function sendAutoEmail({ companyId, lead, emailSettings }) {
  const {
    subject      = "Welcome! We'll be in touch soon.",
    fromName     = "",
    bodyTemplate = "<p>Hi {{name}},</p><p>Thank you for your interest. Our team will reach out shortly.</p>",
  } = emailSettings;

  if (!lead.email || !lead.email.trim()) {
    console.warn(`[autoTemplate] ❌ Email skipped — lead has no email address`);
    return;
  }

  const html = bodyTemplate
    .replace(/{{name}}/g,     lead.name     || "")
    .replace(/{{mobile}}/g,   lead.mobile   || "")
    .replace(/{{campaign}}/g, lead.campaign || "")
    .replace(/{{email}}/g,    lead.email    || "");

  const finalSubject = subject.replace(/{{name}}/g, lead.name || "");

  console.log(`[autoTemplate] 📤 Email → ${lead.email} subject="${finalSubject}"`);

  try {
    const provider = await sendSmartEmail({
      to:        lead.email.trim(),
      toName:    lead.name || "",
      subject:   finalSubject,
      html,
      fromName,
      companyId,
    });

    console.log(`[autoTemplate] ✅ Email sent to ${lead.email} via ${provider}`);

    await EmailLog.create({
      to:         lead.email.trim(),
      subject:    finalSubject,
      body:       html,
      campaignId: "auto-template",
      status:     "sent",
      provider,
      company:    companyId,
    });
  } catch (err) {
    const errMsg = err?.response?.data?.message || err.message;
    console.error(`[autoTemplate] ❌ Email failed for ${lead.email}:`, errMsg);
    await EmailLog.create({
      to:           lead.email.trim(),
      subject:      finalSubject,
      body:         html,
      campaignId:   "auto-template",
      status:       "failed",
      errorMessage: errMsg,
      company:      companyId,
    }).catch(() => {});
  }
}

// ─── 3. SMS (MSG91) ──────────────────────────────────────────────────────────
async function sendAutoSms({ companyId, lead, smsSettings }) {
  const { templateId = "", senderId = "" } = smsSettings;

  const smsConfig = await SmsConfig.findOne({ company: companyId }).lean();
  const authKey   = smsConfig?.msg91AuthKey || "";

  const resolvedTemplateId = templateId || smsConfig?.greetingsTemplateId || "1007503933418344595";
  const resolvedSenderId   = senderId || smsConfig?.greetingsSenderId || smsConfig?.msg91SenderId || "695382";

  if (!authKey) {
    console.warn(`[autoTemplate] ❌ SMS skipped — MSG91 authKey not configured for company ${companyId}`);
    return;
  }

  let phone = (lead.mobile || "").replace(/\D/g, "");
  if (phone.startsWith("0091")) phone = phone.slice(4);
  if (phone.startsWith("00"))   phone = phone.slice(2);
  if (phone.length === 10)      phone = "91" + phone;

  if (phone.length < 12) {
    console.warn(`[autoTemplate] ❌ SMS skipped — invalid phone: "${phone}"`);
    return;
  }

  const leadName = (lead.name || "there").trim();
  const payload = {
    flow_id:   resolvedTemplateId,
    sender:    resolvedSenderId,
    short_url: "0",
    route:     "1",  // ✅ Promotional route (not "4" transactional)
    mobiles:   phone,
    VAR1:      leadName,
  };

  console.log(`[autoTemplate] 📤 SMS → ${phone} VAR1="${leadName}"`);

  const logMessage = `Hi ${leadName}, thank you for contacting SKYUP Digital Solutions LLP!`;

  try {
    const { data } = await axios.post(
      "https://control.msg91.com/api/v5/flow/",
      payload,
      { headers: { authkey: authKey, "Content-Type": "application/json", accept: "application/json" } }
    );
    if (data?.type === "error") throw new Error(data?.message || "MSG91 SMS error");
    console.log(`[autoTemplate] ✅ SMS sent to ${phone}:`, JSON.stringify(data));

    await SmsLog.create({
      to:             phone,
      recipientName:  lead.name || "",
      message:        logMessage,
      templateId:     resolvedTemplateId,
      senderId:       resolvedSenderId,
      campaignId:     "auto-template",
      status:         "sent",
      msg91RequestId: String(data?.message || data?.requestId || ""),
      company:        companyId,
    });
  } catch (err) {
    const errMsg = err?.response?.data?.message || err.message;
    console.error(`[autoTemplate] ❌ SMS failed for ${phone}:`, errMsg);
    await SmsLog.create({
      to:            phone,
      recipientName: lead.name || "",
      message:       logMessage,
      campaignId:    "auto-template",
      status:        "failed",
      errorMessage:  errMsg,
      company:       companyId,
    }).catch(() => {});
  }
}

// ─── Main: Auto-send for NEW LEADS ───────────────────────────────────────────
async function autoSendTemplates(lead, companyId) {
  if (!companyId || !lead) {
    console.warn("[autoTemplate] ❌ Skipped — missing lead or companyId");
    return;
  }

  console.log(`[autoTemplate] ▶ New lead: "${lead.name}" company=${companyId}`);

  try {
    const company = await Company.findById(companyId).select("autoTemplate").lean();
    if (!company?.autoTemplate) {
      console.warn(`[autoTemplate] ❌ Skipped — autoTemplate not configured`);
      return;
    }

    const { whatsapp, email, sms } = company.autoTemplate;
    const tasks = [];

    if (whatsapp?.enabled && lead.mobile) {
      tasks.push(
        sendAutoWhatsApp({ companyId, lead, whatsappSettings: whatsapp })
          .catch(err => console.error("[autoTemplate] WA failed:", err.message))
      );
    }
    if (email?.enabled && lead.email) {
      tasks.push(
        sendAutoEmail({ companyId, lead, emailSettings: email })
          .catch(err => console.error("[autoTemplate] Email failed:", err.message))
      );
    }
    if (sms?.enabled && lead.mobile) {
      tasks.push(
        sendAutoSms({ companyId, lead, smsSettings: sms })
          .catch(err => console.error("[autoTemplate] SMS failed:", err.message))
      );
    }

    await Promise.allSettled(tasks);
    console.log(`[autoTemplate] ✅ Done for new lead "${lead.name}"`);
  } catch (err) {
    console.error("[autoTemplate] ❌ Top-level error:", err.message);
  }
}

// ─── NEW: Auto-blast for INTERESTED STATUS LEADS ─────────────────────────────
// Called when a lead's status changes to "Interested"
async function sendInterestedBlast(lead, companyId) {
  if (!companyId || !lead) {
    console.warn("[interestedBlast] ❌ Skipped — missing lead or companyId");
    return;
  }

  console.log(`[interestedBlast] ▶ Lead "${lead.name}" marked Interested — company=${companyId}`);

  try {
    const company = await Company.findById(companyId).select("interestedBlast").lean();
    if (!company?.interestedBlast) {
      console.warn(`[interestedBlast] ❌ Skipped — interestedBlast not configured`);
      return;
    }

    const { whatsapp, email, sms } = company.interestedBlast;
    const tasks = [];

    if (whatsapp?.enabled && lead.mobile) {
      tasks.push(
        sendAutoWhatsApp({ companyId, lead, whatsappSettings: whatsapp })
          .catch(err => console.error("[interestedBlast] WA failed:", err.message))
      );
    } else if (whatsapp?.enabled && !lead.mobile) {
      console.warn("[interestedBlast] WA enabled but lead has no mobile");
    }

    if (email?.enabled && lead.email) {
      tasks.push(
        sendAutoEmail({ companyId, lead, emailSettings: email })
          .catch(err => console.error("[interestedBlast] Email failed:", err.message))
      );
    } else if (email?.enabled && !lead.email) {
      console.warn("[interestedBlast] Email enabled but lead has no email");
    }

    if (sms?.enabled && lead.mobile) {
      tasks.push(
        sendAutoSms({ companyId, lead, smsSettings: sms })
          .catch(err => console.error("[interestedBlast] SMS failed:", err.message))
      );
    } else if (sms?.enabled && !lead.mobile) {
      console.warn("[interestedBlast] SMS enabled but lead has no mobile");
    }

    await Promise.allSettled(tasks);
    console.log(`[interestedBlast] ✅ Done for lead "${lead.name}"`);
  } catch (err) {
    console.error("[interestedBlast] ❌ Top-level error:", err.message);
  }
}

module.exports = { autoSendTemplates, sendInterestedBlast };