// services/autoTemplateService.js
//
// Directly sends WhatsApp template, Email, and SMS to a new lead
// when the company's auto-template toggles are enabled.
//
// ⚠️  This file uses in-process function calls instead of internal
//     HTTP requests, so it NEVER needs an auth token or Bearer header.
//     This fixes the root cause where INTERNAL_ADMIN_TOKEN was not a
//     valid JWT and all internal axios calls returned 401 silently.

"use strict";

const axios          = require("axios");
const Company        = require("../models/Company");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const SmsConfig      = require("../models/SmsConfig");
const EmailLog       = require("../models/EmailLog");
const SmsLog         = require("../models/SmsLog");

// ─────────────────────────────────────────────────────────────────────────────
// Util: normalise a phone number to full E.164 digits (no +)
// ─────────────────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.startsWith("00"))   digits = digits.slice(2);
  if (digits.startsWith("0"))    digits = digits.slice(1);
  if (digits.length === 10)      digits = "91" + digits;
  return digits;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.  WhatsApp template sender
// ─────────────────────────────────────────────────────────────────────────────
async function sendAutoWhatsApp({ companyId, lead, whatsappSettings }) {
  const { templateName = "crm_lead_followup", languageCode = "en_US" } = whatsappSettings;

  const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true }).lean();
  if (!config) {
    console.warn(`[autoTemplate] WA skipped — no active WhatsAppConfig for company ${companyId}`);
    return;
  }

  const provider     = config.provider || "msg91";
  const authKey      = config.msg91AuthKey;
  const senderNumber = config.msg91IntegratedNumber;
  const cleanPhone   = normalizePhone(lead.mobile);

  if (cleanPhone.length < 10) {
    console.warn(`[autoTemplate] WA skipped — invalid phone: ${lead.mobile}`);
    return;
  }

  if (provider === "msg91") {
    if (!authKey || !senderNumber) {
      console.warn(`[autoTemplate] WA skipped — MSG91 credentials missing for company ${companyId}`);
      return;
    }

    // MSG91 namespace — stored in config if present, otherwise fall back to the
    // value from the WhatsApp Business dashboard.  Store it in WhatsAppConfig
    // so each company can have its own (see Bug #4 fix note in README).
    const namespace = config.msg91Namespace || "";

    const components = (lead.name || "").trim()
      ? { body_customer_name: { type: "text", value: lead.name.trim(), parameter_name: "customer_name" } }
      : {};

    const requestPayload = {
      integrated_number: senderNumber,
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name:     templateName.trim(),
          language: { code: languageCode || "en_US", policy: "deterministic" },
          ...(namespace ? { namespace } : {}),
          to_and_components: [{ to: [cleanPhone], components }],
        },
      },
    };

    console.log(`[autoTemplate] 📤 WA MSG91 → ${cleanPhone} template="${templateName}"`);

    const resp = await axios.post(
      "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
      requestPayload,
      { headers: { authkey: authKey, "Content-Type": "application/json" } }
    );

    console.log(`[autoTemplate] ✅ WA MSG91 response:`, JSON.stringify(resp.data));

  } else {
    // Meta Cloud API
    if (!config.phoneNumberId || !config.accessToken) {
      console.warn(`[autoTemplate] WA skipped — Meta credentials missing for company ${companyId}`);
      return;
    }

    const apiUrl = `https://graph.facebook.com/${config.graphApiVersion || "v21.0"}/${config.phoneNumberId}/messages`;
    const metaPayload = {
      messaging_product: "whatsapp",
      to:   cleanPhone,
      type: "template",
      template: {
        name:     templateName.trim(),
        language: { code: languageCode || "en_US" },
      },
    };

    console.log(`[autoTemplate] 📤 WA Meta → ${cleanPhone} template="${templateName}"`);

    const resp = await axios.post(apiUrl, metaPayload, {
      headers: {
        Authorization:  `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
    });

    console.log(`[autoTemplate] ✅ WA Meta response:`, JSON.stringify(resp.data));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.  Email sender (Brevo / Sendinblue)
// ─────────────────────────────────────────────────────────────────────────────
async function sendAutoEmail({ companyId, lead, emailSettings }) {
  const {
    subject      = "Welcome! We'll be in touch soon.",
    fromName     = "",
    bodyTemplate = "<p>Hi {{name}},</p><p>Thank you for your interest. Our team will reach out to you shortly.</p>",
  } = emailSettings;

  // Load Brevo credentials — must use +brevoApiKey selector to bypass select:false
  const company = await Company.findById(companyId)
    .select("+brevoApiKey brevoSenderEmail brevoSenderName")
    .lean();

  const apiKey    = company?.brevoApiKey      || "";
  const fromEmail = company?.brevoSenderEmail || "";
  const sender    = fromName || company?.brevoSenderName || "CRM";

  if (!apiKey || !fromEmail) {
    console.warn(`[autoTemplate] Email skipped — Brevo not configured for company ${companyId}`);
    return;
  }

  if (!lead.email || !lead.email.trim()) {
    console.warn(`[autoTemplate] Email skipped — lead has no email`);
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
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender:      { name: sender, email: fromEmail },
        to:          [{ email: lead.email.trim(), name: lead.name || "" }],
        subject:     finalSubject,
        htmlContent: html,
      },
      { headers: { "api-key": apiKey, "Content-Type": "application/json" } }
    );

    console.log(`[autoTemplate] ✅ Email sent to ${lead.email}`);

    await EmailLog.create({
      to:         lead.email.trim(),
      subject:    finalSubject,
      body:       html,
      campaignId: "auto-template",
      status:     "sent",
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

// ─────────────────────────────────────────────────────────────────────────────
// 3.  SMS sender (MSG91)
// ─────────────────────────────────────────────────────────────────────────────
async function sendAutoSms({ companyId, lead, smsSettings }) {
  const {
    message    = "Hi {{name}}, thanks for your interest! Our team will contact you soon.",
    templateId = "",
    senderId   = "",
  } = smsSettings;

  const smsConfig = await SmsConfig.findOne({ company: companyId }).lean();
  const authKey   = smsConfig?.msg91AuthKey  || "";
  const defaultSenderId = senderId || smsConfig?.msg91SenderId || "SKYCRM";

  if (!authKey) {
    console.warn(`[autoTemplate] SMS skipped — MSG91 authKey not configured for company ${companyId}`);
    return;
  }

  let phone = (lead.mobile || "").replace(/\D/g, "");
  if (phone.length === 10) phone = "91" + phone;

  if (phone.length < 12) {
    console.warn(`[autoTemplate] SMS skipped — invalid phone: ${lead.mobile}`);
    return;
  }

  const body = message
    .replace(/{{name}}/g,     lead.name     || "")
    .replace(/{{mobile}}/g,   lead.mobile   || "")
    .replace(/{{campaign}}/g, lead.campaign || "");

  const payload = {
    sender:  defaultSenderId,
    route:   "4",
    country: "91",
    sms:     [{ message: body, to: [phone] }],
  };
  if (templateId) payload.template_id = templateId;

  console.log(`[autoTemplate] 📤 SMS → ${phone}`);

  try {
    const { data } = await axios.post(
      "https://api.msg91.com/api/v5/flow/",
      payload,
      {
        headers: {
          authkey:        authKey,
          "Content-Type": "application/json",
          Accept:         "application/json",
        },
      }
    );

    if (data?.type === "error") throw new Error(data?.message || "MSG91 error");

    console.log(`[autoTemplate] ✅ SMS sent to ${phone}:`, data?.message || "ok");

    await SmsLog.create({
      to:             phone,
      recipientName:  lead.name || "",
      message:        body,
      templateId:     templateId || null,
      senderId:       defaultSenderId,
      campaignId:     "auto-template",
      status:         "sent",
      msg91RequestId: String(data?.message || data?.requestId || ""),
      company:        companyId,
    });
  } catch (err) {
    const errMsg = err?.response?.data?.message || err.message;
    console.error(`[autoTemplate] ❌ SMS failed for ${phone}:`, errMsg);

    await SmsLog.create({
      to:           phone,
      recipientName: lead.name || "",
      message:       body,
      campaignId:    "auto-template",
      status:        "failed",
      errorMessage:  errMsg,
      company:       companyId,
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export — call this after any lead creation
// ─────────────────────────────────────────────────────────────────────────────
async function autoSendTemplates(lead, companyId) {
  if (!companyId) {
    console.warn("[autoTemplate] Skipped — no companyId");
    return;
  }

  try {
    const company = await Company.findById(companyId).select("autoTemplate").lean();
    if (!company?.autoTemplate) {
      console.log("[autoTemplate] Skipped — autoTemplate not set on company");
      return;
    }

    const { whatsapp, email, sms } = company.autoTemplate;

    // Run all three in parallel; each catches its own errors internally
    const tasks = [];

    if (whatsapp?.enabled) {
      if (lead.mobile) {
        tasks.push(
          sendAutoWhatsApp({ companyId, lead, whatsappSettings: whatsapp })
            .catch(err => console.error("[autoTemplate] WA uncaught:", err.message))
        );
      } else {
        console.warn("[autoTemplate] WA skipped — lead has no mobile number");
      }
    }

    if (email?.enabled) {
      if (lead.email) {
        tasks.push(
          sendAutoEmail({ companyId, lead, emailSettings: email })
            .catch(err => console.error("[autoTemplate] Email uncaught:", err.message))
        );
      } else {
        console.warn("[autoTemplate] Email skipped — lead has no email address");
      }
    }

    if (sms?.enabled) {
      if (lead.mobile) {
        tasks.push(
          sendAutoSms({ companyId, lead, smsSettings: sms })
            .catch(err => console.error("[autoTemplate] SMS uncaught:", err.message))
        );
      } else {
        console.warn("[autoTemplate] SMS skipped — lead has no mobile number");
      }
    }

    await Promise.allSettled(tasks);

  } catch (err) {
    console.error("[autoTemplate] Top-level error:", err.message);
  }
}

module.exports = { autoSendTemplates };