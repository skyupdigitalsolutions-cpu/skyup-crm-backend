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
    return { channel: "whatsapp", status: "skipped", detail: "No active WhatsApp configuration. Connect WhatsApp in Communications → Integrations." };
  }

  const provider     = config.provider || "msg91";
  const authKey      = config.msg91AuthKey      || "";
  const senderNumber = config.msg91IntegratedNumber || "";
  const cleanPhone   = normalizePhone(lead.mobile);

  if (!cleanPhone || cleanPhone.length < 10) {
    console.warn(`[autoTemplate] ❌ WA skipped — invalid phone: "${cleanPhone}"`);
    return { channel: "whatsapp", status: "skipped", detail: `Lead has an invalid phone number ("${lead.mobile || ""}")` };
  }

  if (provider === "msg91") {
    if (!authKey || !senderNumber) {
      console.warn(`[autoTemplate] ❌ WA skipped — MSG91 credentials missing`);
      return { channel: "whatsapp", status: "skipped", detail: "MSG91 WhatsApp authkey / integrated number missing in WhatsApp settings." };
    }

    const namespace   = config.msg91Namespace   || "";
    const brochureUrl = config.msg91BrochureUrl || "";

    // EXACT same component format as the proven-working chat/bulk sender
    // (_sendTemplateToPhone in whatsappChatController.js):
    //   • body_1   → positional {{1}} body variable (the lead's name)
    //   • header_1 → document header (brochure) when configured — templates
    //                with a document header REJECT sends that omit it.
    const components = {
      ...(brochureUrl
        ? {
            header_1: {
              type:     "document",
              value:    brochureUrl,
              filename: "Brochure.pdf",
            },
          }
        : {}),
      body_1: {
        type:  "text",
        value: (lead.name || "").trim() || "there",
      },
    };

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
      // MSG91 can return HTTP 200 with an error status in the body
      if (resp.data && (resp.data.status === "fail" || resp.data.hasError === true || resp.data.type === "error")) {
        const detail = JSON.stringify(resp.data.errors || resp.data.message || resp.data);
        console.error(`[autoTemplate] ❌ WA rejected by MSG91:`, detail);
        return { channel: "whatsapp", status: "failed", detail: `MSG91 rejected the message: ${detail}` };
      }
      return { channel: "whatsapp", status: "sent", detail: `Sent to ${cleanPhone} using template "${templateName}"` };
    } catch (err) {
      const detail = JSON.stringify(err?.response?.data || err.message);
      console.error(`[autoTemplate] ❌ WA error:`, detail);
      return { channel: "whatsapp", status: "failed", detail };
    }

  } else {
    if (!config.phoneNumberId || !config.accessToken) {
      console.warn(`[autoTemplate] ❌ WA skipped — Meta credentials missing`);
      return { channel: "whatsapp", status: "skipped", detail: "Meta WhatsApp phoneNumberId / accessToken missing in WhatsApp settings." };
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
      return { channel: "whatsapp", status: "sent", detail: `Sent to ${cleanPhone} via Meta using template "${templateName}"` };
    } catch (err) {
      const detail = JSON.stringify(err?.response?.data || err.message);
      console.error(`[autoTemplate] ❌ WA Meta error:`, detail);
      return { channel: "whatsapp", status: "failed", detail };
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
    return { channel: "email", status: "skipped", detail: "Lead has no email address." };
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
    return { channel: "email", status: "sent", detail: `Sent to ${lead.email.trim()} via ${provider}` };
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
    return { channel: "email", status: "failed", detail: errMsg };
  }
}

// ─── 3. SMS (MSG91) ──────────────────────────────────────────────────────────
async function sendAutoSms({ companyId, lead, smsSettings }) {
  const { templateId = "", senderId = "" } = smsSettings;

  const smsConfig = await SmsConfig.findOne({ company: companyId }).lean();
  const authKey   = smsConfig?.msg91AuthKey || "";

  // MSG91's /api/v5/flow/ endpoint needs the MSG91 FLOW ID (24-char hex,
  // e.g. "6a1ffe028c6272147b00b233") in flow_id — NOT the 19-digit DLT/TRAI
  // template number. If the panel value looks like a DLT number (long pure
  // digits), it would be rejected by MSG91 — fall back to the saved working
  // Greetings Flow ID instead and note the correction.
  const looksLikeDltNumber = (v) => /^\d{15,}$/.test((v || "").trim());
  const greetingsFlowId    = smsConfig?.greetingsTemplateId || "6a1ffe028c6272147b00b233";

  let resolvedTemplateId = (templateId || "").trim();
  let correctionNote = "";
  if (!resolvedTemplateId) {
    resolvedTemplateId = greetingsFlowId;
  } else if (looksLikeDltNumber(resolvedTemplateId)) {
    correctionNote = ` (note: "${resolvedTemplateId}" in settings is a DLT number, not an MSG91 Flow ID — used saved Greetings Flow ID instead)`;
    resolvedTemplateId = greetingsFlowId;
  }

  // Sender fallback mirrors the working campaign path: panel value →
  // greetings sender → 695382. (msg91SenderId like "SKYCRM" belongs to a
  // different DLT registration and would be rejected for the greetings flow.)
  const resolvedSenderId = (senderId || "").trim() || smsConfig?.greetingsSenderId || "695382";

  if (!authKey) {
    console.warn(`[autoTemplate] ❌ SMS skipped — MSG91 authKey not configured for company ${companyId}`);
    return { channel: "sms", status: "skipped", detail: "MSG91 SMS authkey not configured. Connect SMS in Communications → Integrations." };
  }

  let phone = (lead.mobile || "").replace(/\D/g, "");
  if (phone.startsWith("0091")) phone = phone.slice(4);
  if (phone.startsWith("00"))   phone = phone.slice(2);
  if (phone.length === 10)      phone = "91" + phone;

  if (phone.length < 12) {
    console.warn(`[autoTemplate] ❌ SMS skipped — invalid phone: "${phone}"`);
    return { channel: "sms", status: "skipped", detail: `Lead has an invalid phone number ("${lead.mobile || ""}")` };
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
    return { channel: "sms", status: "sent", detail: `Sent to ${phone} (flow ${resolvedTemplateId}, sender ${resolvedSenderId})${correctionNote}` };
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
    return { channel: "sms", status: "failed", detail: errMsg };
  }
}

// ─── Main: Auto-send for NEW LEADS ───────────────────────────────────────────
// Returns an array of per-channel results: { channel, status: "sent"|"skipped"|"failed", detail }
async function autoSendTemplates(lead, companyId) {
  const results = [];
  if (!companyId || !lead) {
    console.warn("[autoTemplate] ❌ Skipped — missing lead or companyId");
    return [{ channel: "all", status: "skipped", detail: "Missing lead or companyId" }];
  }

  console.log(`[autoTemplate] ▶ New lead: "${lead.name}" company=${companyId}`);

  try {
    const company = await Company.findById(companyId).select("autoTemplate").lean();
    if (!company?.autoTemplate) {
      console.warn(`[autoTemplate] ❌ Skipped — autoTemplate not configured`);
      return [{ channel: "all", status: "skipped", detail: "Auto-template settings have never been saved. Open Communications → Auto-Template settings and click Save." }];
    }

    const { whatsapp, email, sms } = company.autoTemplate;
    const tasks = [];

    if (whatsapp?.enabled) {
      if (lead.mobile) {
        tasks.push(
          sendAutoWhatsApp({ companyId, lead, whatsappSettings: whatsapp })
            .catch(err => ({ channel: "whatsapp", status: "failed", detail: err.message }))
        );
      } else {
        results.push({ channel: "whatsapp", status: "skipped", detail: "Lead has no mobile number" });
      }
    } else {
      results.push({ channel: "whatsapp", status: "skipped", detail: "WhatsApp toggle is OFF in Auto-Template settings" });
    }

    if (email?.enabled) {
      if (lead.email) {
        tasks.push(
          sendAutoEmail({ companyId, lead, emailSettings: email })
            .catch(err => ({ channel: "email", status: "failed", detail: err.message }))
        );
      } else {
        results.push({ channel: "email", status: "skipped", detail: "Lead has no email address" });
      }
    } else {
      results.push({ channel: "email", status: "skipped", detail: "Email toggle is OFF in Auto-Template settings" });
    }

    if (sms?.enabled) {
      if (lead.mobile) {
        tasks.push(
          sendAutoSms({ companyId, lead, smsSettings: sms })
            .catch(err => ({ channel: "sms", status: "failed", detail: err.message }))
        );
      } else {
        results.push({ channel: "sms", status: "skipped", detail: "Lead has no mobile number" });
      }
    } else {
      results.push({ channel: "sms", status: "skipped", detail: "SMS toggle is OFF in Auto-Template settings" });
    }

    const settled = await Promise.allSettled(tasks);
    settled.forEach(s => { if (s.status === "fulfilled" && s.value) results.push(s.value); });
    console.log(`[autoTemplate] ✅ Done for new lead "${lead.name}":`, JSON.stringify(results));
    return results;
  } catch (err) {
    console.error("[autoTemplate] ❌ Top-level error:", err.message);
    results.push({ channel: "all", status: "failed", detail: err.message });
    return results;
  }
}

// ─── Auto-blast for INTERESTED STATUS LEADS ─────────────────────────────────
// Called when a lead is marked "Interested" (status or call outcome).
// Returns an array of per-channel results: { channel, status: "sent"|"skipped"|"failed", detail }
async function sendInterestedBlast(lead, companyId) {
  const results = [];
  if (!companyId || !lead) {
    console.warn("[interestedBlast] ❌ Skipped — missing lead or companyId");
    return [{ channel: "all", status: "skipped", detail: "Missing lead or companyId" }];
  }

  console.log(`[interestedBlast] ▶ Lead "${lead.name}" marked Interested — company=${companyId}`);

  try {
    // Uses the same Auto-Blast settings (toggles + templates) as the new-lead
    // flow — one settings panel in Communications controls both triggers.
    const company = await Company.findById(companyId).select("autoTemplate interestedBlast").lean();
    const settingsSource = company?.autoTemplate || company?.interestedBlast;
    if (!settingsSource) {
      console.warn(`[interestedBlast] ❌ Skipped — auto-blast settings not configured`);
      return [{ channel: "all", status: "skipped", detail: "Auto-blast settings have never been saved. Open Communications → New Lead settings and click Save." }];
    }

    const { whatsapp, email, sms } = settingsSource;
    const tasks = [];

    if (whatsapp?.enabled) {
      if (lead.mobile) {
        tasks.push(
          sendAutoWhatsApp({ companyId, lead, whatsappSettings: whatsapp })
            .catch(err => ({ channel: "whatsapp", status: "failed", detail: err.message }))
        );
      } else {
        console.warn("[interestedBlast] WA enabled but lead has no mobile");
        results.push({ channel: "whatsapp", status: "skipped", detail: "Lead has no mobile number" });
      }
    } else {
      results.push({ channel: "whatsapp", status: "skipped", detail: "WhatsApp toggle is OFF in Auto-Blast (New Lead) settings" });
    }

    if (email?.enabled) {
      if (lead.email) {
        tasks.push(
          sendAutoEmail({ companyId, lead, emailSettings: email })
            .catch(err => ({ channel: "email", status: "failed", detail: err.message }))
        );
      } else {
        console.warn("[interestedBlast] Email enabled but lead has no email");
        results.push({ channel: "email", status: "skipped", detail: "Lead has no email address" });
      }
    } else {
      results.push({ channel: "email", status: "skipped", detail: "Email toggle is OFF in Auto-Blast (New Lead) settings" });
    }

    if (sms?.enabled) {
      if (lead.mobile) {
        tasks.push(
          sendAutoSms({ companyId, lead, smsSettings: sms })
            .catch(err => ({ channel: "sms", status: "failed", detail: err.message }))
        );
      } else {
        console.warn("[interestedBlast] SMS enabled but lead has no mobile");
        results.push({ channel: "sms", status: "skipped", detail: "Lead has no mobile number" });
      }
    } else {
      results.push({ channel: "sms", status: "skipped", detail: "SMS toggle is OFF in Auto-Blast (New Lead) settings" });
    }

    const settled = await Promise.allSettled(tasks);
    settled.forEach(s => { if (s.status === "fulfilled" && s.value) results.push(s.value); });
    console.log(`[interestedBlast] ✅ Done for lead "${lead.name}":`, JSON.stringify(results));
    return results;
  } catch (err) {
    console.error("[interestedBlast] ❌ Top-level error:", err.message);
    results.push({ channel: "all", status: "failed", detail: err.message });
    return results;
  }
}

// sendAutoWhatsApp / sendAutoEmail are exported (in addition to the two
// higher-level blast functions above) so other automations — e.g.
// jobs/followUpReminderJob.js — can send a WhatsApp/Email message to a lead
// using a company's saved WhatsApp/Brevo/MSG91 config without duplicating
// the provider-selection and payload-building logic here.
module.exports = {
  autoSendTemplates,
  sendInterestedBlast,
  sendSmartEmail,
  sendAutoWhatsApp,
  sendAutoEmail,
};