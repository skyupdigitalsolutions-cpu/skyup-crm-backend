// services/autoTemplateService.js
//
// Directly sends WhatsApp template, Email, and SMS to a new lead
// when the company's auto-template toggles are enabled.
//
// Uses in-process function calls — NO internal HTTP, NO auth tokens needed.

"use strict";

const axios          = require("axios");
const Company        = require("../models/Company");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const SmsConfig      = require("../models/SmsConfig");
const EmailLog       = require("../models/EmailLog");
const SmsLog         = require("../models/SmsLog");

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

// ─── 1. WhatsApp ─────────────────────────────────────────────────────────────
async function sendAutoWhatsApp({ companyId, lead, whatsappSettings }) {
  const { templateName = "crm_lead_followup", languageCode = "en_US" } = whatsappSettings;

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

  console.log(`[autoTemplate] WA config: provider=${provider}, senderNumber=${senderNumber}, authKey=${authKey ? "SET" : "MISSING"}`);
  console.log(`[autoTemplate] WA lead mobile: "${lead.mobile}" → cleaned: "${cleanPhone}"`);

  if (!cleanPhone || cleanPhone.length < 10) {
    console.warn(`[autoTemplate] ❌ WA skipped — invalid phone after normalise: "${cleanPhone}"`);
    return;
  }

  if (provider === "msg91") {
    if (!authKey) {
      console.warn(`[autoTemplate] ❌ WA skipped — MSG91 authKey is missing`);
      return;
    }
    if (!senderNumber) {
      console.warn(`[autoTemplate] ❌ WA skipped — MSG91 integratedNumber is missing`);
      return;
    }

    const namespace  = config.msg91Namespace || "";
    const components = (lead.name || "").trim()
      ? { body_customer_name: { type: "text", value: lead.name.trim(), parameter_name: "customer_name" } }
      : {};

    const templateBlock = {
      name:              templateName.trim(),
      language:          { code: languageCode || "en_US", policy: "deterministic" },
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

    console.log(`[autoTemplate] 📤 WA MSG91 request → phone=${cleanPhone} template="${templateName}"`);
    console.log(`[autoTemplate] WA payload:`, JSON.stringify(requestPayload, null, 2));

    try {
      const resp = await axios.post(
        "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/",
        requestPayload,
        { headers: { authkey: authKey, "Content-Type": "application/json" } }
      );
      console.log(`[autoTemplate] ✅ WA MSG91 response:`, JSON.stringify(resp.data));
    } catch (err) {
      const errData = err?.response?.data;
      console.error(`[autoTemplate] ❌ WA MSG91 API error (HTTP ${err?.response?.status}):`, JSON.stringify(errData || err.message));
      throw err;
    }

  } else {
    // Meta Cloud API
    if (!config.phoneNumberId || !config.accessToken) {
      console.warn(`[autoTemplate] ❌ WA skipped — Meta credentials missing`);
      return;
    }

    const apiUrl = `https://graph.facebook.com/${config.graphApiVersion || "v21.0"}/${config.phoneNumberId}/messages`;
    const metaPayload = {
      messaging_product: "whatsapp",
      to:   cleanPhone,
      type: "template",
      template: { name: templateName.trim(), language: { code: languageCode || "en_US" } },
    };

    console.log(`[autoTemplate] 📤 WA Meta request → phone=${cleanPhone} template="${templateName}"`);

    try {
      const resp = await axios.post(apiUrl, metaPayload, {
        headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      });
      console.log(`[autoTemplate] ✅ WA Meta response:`, JSON.stringify(resp.data));
    } catch (err) {
      const errData = err?.response?.data;
      console.error(`[autoTemplate] ❌ WA Meta API error (HTTP ${err?.response?.status}):`, JSON.stringify(errData || err.message));
      throw err;
    }
  }
}

// ─── 2. Email (Brevo) ────────────────────────────────────────────────────────
async function sendAutoEmail({ companyId, lead, emailSettings }) {
  const {
    subject      = "Welcome! We'll be in touch soon.",
    fromName     = "",
    bodyTemplate = "<p>Hi {{name}},</p><p>Thank you for your interest. Our team will reach out shortly.</p>",
  } = emailSettings;

  console.log(`[autoTemplate] Email → lead.email="${lead.email}" companyId=${companyId}`);

  if (!lead.email || !lead.email.trim()) {
    console.warn(`[autoTemplate] ❌ Email skipped — lead has no email address`);
    return;
  }

  // Must use +brevoApiKey to bypass select:false
  const company = await Company.findById(companyId)
    .select("+brevoApiKey brevoSenderEmail brevoSenderName")
    .lean();

  const apiKey    = company?.brevoApiKey      || "";
  const fromEmail = company?.brevoSenderEmail || "";
  const sender    = fromName || company?.brevoSenderName || "CRM";

  console.log(`[autoTemplate] Email Brevo: apiKey=${apiKey ? "SET" : "MISSING"}, fromEmail="${fromEmail}"`);

  if (!apiKey) {
    console.warn(`[autoTemplate] ❌ Email skipped — Brevo API key not configured for company ${companyId}`);
    return;
  }
  if (!fromEmail) {
    console.warn(`[autoTemplate] ❌ Email skipped — Brevo sender email not configured for company ${companyId}`);
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
    console.error(`[autoTemplate] ❌ Email failed for ${lead.email}:`, errMsg, JSON.stringify(err?.response?.data));
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
  const {
    message    = "Hi {{name}}, thanks for your interest! Our team will contact you soon.",
    templateId = "",
    senderId   = "",
  } = smsSettings;

  console.log(`[autoTemplate] SMS → lead.mobile="${lead.mobile}" companyId=${companyId}`);

  const smsConfig = await SmsConfig.findOne({ company: companyId }).lean();
  const authKey   = smsConfig?.msg91AuthKey  || "";
  const defaultSenderId = senderId || smsConfig?.msg91SenderId || "SKYCRM";

  console.log(`[autoTemplate] SMS MSG91: authKey=${authKey ? "SET" : "MISSING"}, senderId="${defaultSenderId}"`);

  if (!authKey) {
    console.warn(`[autoTemplate] ❌ SMS skipped — MSG91 authKey not configured for company ${companyId}`);
    return;
  }

  let phone = (lead.mobile || "").replace(/\D/g, "");
  if (phone.length === 10) phone = "91" + phone;

  if (phone.length < 12) {
    console.warn(`[autoTemplate] ❌ SMS skipped — invalid phone after normalise: "${phone}"`);
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

  console.log(`[autoTemplate] 📤 SMS → ${phone} message="${body}"`);

  try {
    const { data } = await axios.post(
      "https://api.msg91.com/api/v5/flow/",
      payload,
      { headers: { authkey: authKey, "Content-Type": "application/json", Accept: "application/json" } }
    );

    if (data?.type === "error") throw new Error(data?.message || "MSG91 SMS error");

    console.log(`[autoTemplate] ✅ SMS sent to ${phone}:`, JSON.stringify(data));

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
    console.error(`[autoTemplate] ❌ SMS failed for ${phone}:`, errMsg, JSON.stringify(err?.response?.data));
    await SmsLog.create({
      to:            phone,
      recipientName: lead.name || "",
      message:       body,
      campaignId:    "auto-template",
      status:        "failed",
      errorMessage:  errMsg,
      company:       companyId,
    }).catch(() => {});
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────
async function autoSendTemplates(lead, companyId) {
  if (!companyId) {
    console.warn("[autoTemplate] ❌ Skipped — companyId is missing");
    return;
  }
  if (!lead) {
    console.warn("[autoTemplate] ❌ Skipped — lead object is null/undefined");
    return;
  }

  console.log(`[autoTemplate] ▶ Starting for lead "${lead.name}" (${lead._id}) company=${companyId}`);
  console.log(`[autoTemplate] Lead fields: mobile="${lead.mobile}" email="${lead.email}"`);

  try {
    const company = await Company.findById(companyId).select("autoTemplate").lean();

    if (!company) {
      console.warn(`[autoTemplate] ❌ Skipped — Company not found: ${companyId}`);
      return;
    }
    if (!company.autoTemplate) {
      console.warn(`[autoTemplate] ❌ Skipped — autoTemplate not set on company`);
      return;
    }

    const { whatsapp, email, sms } = company.autoTemplate;

    console.log(`[autoTemplate] Settings: WA.enabled=${whatsapp?.enabled}, Email.enabled=${email?.enabled}, SMS.enabled=${sms?.enabled}`);

    const tasks = [];

    // WhatsApp
    if (whatsapp?.enabled) {
      if (lead.mobile) {
        tasks.push(
          sendAutoWhatsApp({ companyId, lead, whatsappSettings: whatsapp })
            .catch(err => console.error("[autoTemplate] WA task failed:", err.message))
        );
      } else {
        console.warn("[autoTemplate] ⚠️  WA enabled but lead has no mobile number");
      }
    } else {
      console.log("[autoTemplate] WA toggle is OFF — skipping");
    }

    // Email
    if (email?.enabled) {
      if (lead.email) {
        tasks.push(
          sendAutoEmail({ companyId, lead, emailSettings: email })
            .catch(err => console.error("[autoTemplate] Email task failed:", err.message))
        );
      } else {
        console.warn("[autoTemplate] ⚠️  Email enabled but lead has no email address");
      }
    } else {
      console.log("[autoTemplate] Email toggle is OFF — skipping");
    }

    // SMS
    if (sms?.enabled) {
      if (lead.mobile) {
        tasks.push(
          sendAutoSms({ companyId, lead, smsSettings: sms })
            .catch(err => console.error("[autoTemplate] SMS task failed:", err.message))
        );
      } else {
        console.warn("[autoTemplate] ⚠️  SMS enabled but lead has no mobile number");
      }
    } else {
      console.log("[autoTemplate] SMS toggle is OFF — skipping");
    }

    await Promise.allSettled(tasks);
    console.log(`[autoTemplate] ✅ Done for lead "${lead.name}"`);

  } catch (err) {
    console.error("[autoTemplate] ❌ Top-level error:", err.message, err.stack);
  }
}

module.exports = { autoSendTemplates };