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
const { findTemplate } = require("./msg91TemplateService");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const SmsConfig      = require("../models/SmsConfig");
const EmailLog       = require("../models/EmailLog");
const SmsLog         = require("../models/SmsLog");
const Lead           = require("../models/Leads");
const WhatsAppSendLog = require("../models/WhatsAppSendLog");
const { resolveTemplateContent } = require("../utils/templateContentResolver");
const { buildTemplateName, NICHE_TEMPLATE_PREFIX, resolveWithFallback } = require("../utils/templateNameResolver");

// ── Guard against a static template name that belongs to a DIFFERENT
// industry/service than the lead it's about to be sent to ────────────────────
//
// autoSendTemplates(), outcomeAutomationService.js, followUpReminderJob.js,
// and sendInterestedBlast() all pass a fixed, admin-configured template name
// (e.g. Company.autoTemplate.whatsapp.templateName) with NO per-lead
// resolution — that field was designed for a single generic message like
// "crm_followup_leads", sent to every new lead regardless of vertical.
//
// If an admin instead configures one of the 1,760 industry×service auto-
// resolve library names there (e.g. "digital_marketing_crm_awareness_v2" —
// easy to do by accident, since it's a real, approved, copy-pasteable
// template name), this fixed-name path has always sent it to EVERY lead
// unconditionally, regardless of that lead's actual industry/service. This
// check recognises the auto-resolve naming pattern and blocks the send
// unless it genuinely matches the lead's own tagged industry/service.
//
// A configured name that does NOT match the auto-resolve pattern at all
// (e.g. "crm_followup_leads") is untouched — this only fires for names that
// look like they came from the industry×service library.
const AUTO_LIB_NAME_RE = new RegExp(`_(awareness|interest|desire|action)_v(\\d+)$`, "i");

/**
 * If `templateName` looks like a per-vertical auto-resolve name
 * (…_<stage>_v<n>) but was WRONG for this specific lead (a static config
 * value like "digital_marketing_crm_awareness_v2" being blindly applied to
 * every lead regardless of their actual industry/service), compute the
 * CORRECT name for THIS lead instead — via the same 3-tier fallback chain
 * nurture uses (real industry×service library → service-matched niche →
 * general niche) — rather than just blocking the send outright.
 *
 * This is what makes autoSendTemplates() (the "new lead" welcome message)
 * send content actually relevant to each lead, instead of one static
 * template — e.g. "digital_marketing_crm_awareness_v2" — going out to every
 * single new lead regardless of their real industry or service.
 *
 * Returns:
 *   { corrected: null }                 — name doesn't look like a per-vertical
 *                                          name at all (e.g. "crm_followup_leads"),
 *                                          or it's already correct for this lead.
 *   { corrected: "<name>" }             — send this name instead.
 */
function resolveCorrectedTemplateForLead(templateName, lead) {
  const name = String(templateName || "").trim().toLowerCase();
  const match = AUTO_LIB_NAME_RE.exec(name);
  if (!match) return { corrected: null }; // not a per-vertical name — leave as configured

  const [, stage, variationStr] = match;
  const variation = Number(variationStr) || 1;

  // Niche FALLBACK names (general_awareness_v1, website_awareness_v1,
  // ai_automation_desire_v3 …) end in _<stage>_v<n> too, but they're
  // already correct for an untagged/service-only lead — buildTemplateName()
  // would never match them (they're not industry×service names), so
  // comparing directly would wrongly "correct" a name that's already right.
  const nichePrefixes = Object.values(NICHE_TEMPLATE_PREFIX || {});
  const stem = name.slice(0, name.lastIndexOf(`_${stage}_v${variation}`));
  if (nichePrefixes.includes(stem)) {
    // Configured value IS a niche name — still worth checking whether it's
    // the RIGHT niche for this lead's service (e.g. configured "website_..."
    // but lead's service is "AI Automation") using the same 3-tier resolver.
    const resolved = resolveWithFallback(lead, stage, variation);
    return resolved.templateName === name ? { corrected: null } : { corrected: resolved.templateName };
  }

  const expected = buildTemplateName(lead?.industry, lead?.service, stage, variation);
  if (expected === name) return { corrected: null }; // already correct for this lead

  // Wrong (or lead has no industry/service at all) — resolve what SHOULD go
  // to this lead instead of blocking the send entirely.
  const resolved = resolveWithFallback(lead, stage, variation);
  return { corrected: resolved.templateName };
}

// Append a WhatsApp template send to the lead's templateHistory (shown in the
// Update Lead popup). Fire-and-forget — never blocks or throws into the caller.
// ── Log WhatsApp auto-template sends to WhatsAppSendLog ──────────────────────
// Previously autoTemplateService only wrote to lead.templateHistory, so
// new-lead sends (crm_followup_leads) and interested-blast sends were
// completely invisible in the WhatsApp → Reports table.
// channel/sentByName/ruleId/ruleName let each caller stamp its own correct
// attribution on the ONE log row this function writes for a successful send.
// Previously hardcoded to "Auto-template (New Lead)" regardless of who
// actually triggered the send — so a nurture-rule send, an outcome-based
// send (e.g. "Not Answered" → crm_call_missed), and a plain new-lead welcome
// send were all indistinguishable in the report, and nurture additionally
// wrote a SECOND log row of its own on top of this one for the same send.
async function _logAutoTemplateSend({
  lead, companyId, templateName, status, detail, content = "",
  channel = "manual", sentByName = "Auto-template (New Lead)", ruleId = null, ruleName = "",
}) {
  try {
    await WhatsAppSendLog.create({
      company:      companyId,
      lead:         lead?._id    || null,
      phone:        lead?.mobile || '',
      name:         lead?.name   || '',
      templateName: templateName || '',
      languageCode: 'en',
      content:      content || '',
      channel,
      status:       status === 'sent' ? 'sent' : status === 'skipped' ? 'skipped' : 'failed',
      reason:       detail || '',
      sentByName,
      ...(ruleId ? { ruleId, ruleName } : {}),
    });
  } catch (err) {
    console.warn('[autoTemplate] WhatsAppSendLog write failed:', err.message);
  }
}

// IMPORTANT: this is `async` and MUST be awaited by callers before the next
// rule/send is processed for the same lead. It used to be fire-and-forget
// (no await, just a .catch()), which opened a real race: rule A would send,
// kick off this write, and return immediately — then rule B's dedup check
// would query templateHistory before A's write had landed, find nothing, and
// send the SAME template to the SAME lead again seconds later. That produced
// genuine duplicate WhatsApp messages (confirmed in MSG91's own delivery log
// as two separate billed sends ~6s apart), not just duplicate log rows.
// ── Permanent "never send the same template twice" guard — ATOMIC ────────────
// See the long comment above the previous implementation for the full
// reasoning on WHY this exists. This version replaces a "check, then send,
// then write" sequence — which is NOT safe under true concurrency — with a
// single atomic MongoDB claim, using the exact same pattern already proven
// safe for the nurture atomic claim in jobs/nurtureSequenceJob.js.
//
// THE RACE THIS CLOSES: 5 identical sends of "digital_marketing_crm_
// interest_v1" were observed at the same timestamp for one lead. A plain
// "query templateHistory, then later push to it" check has a window: if two
// (or five) calls run concurrently, ALL of them can read "not sent yet"
// before ANY of their writes land — each one honestly believes it's the
// first. That's the identical class of race already found and fixed for the
// same-day dedup (recordTemplateHistory was fire-and-forget) — this closes
// the analogous gap for the PERMANENT, all-time guard.
//
// HOW IT'S ATOMIC: findOneAndUpdate's filter and update run as one operation
// at the database level. Filtering on `"templateHistory.templateName": {$ne:
// name}` means the push only happens if no entry with that name exists YET —
// MongoDB guarantees only one concurrent writer can win this race; every
// other concurrent caller's filter fails to match (because the winner's push
// already landed) and gets `null` back, atomically, with no window for two
// callers to both "win".
//
// The claimed entry starts as status "pending" — a placeholder, not a
// finished send. If the actual MSG91/Meta send later fails, releaseSendClaim()
// removes the placeholder so a future attempt can retry (a failed send must
// not permanently block all future sends of that template to that lead). If
// the send succeeds, finalizeSendClaim() updates that SAME entry's status to
// "sent" and fills in its content — never a second push.
async function claimTemplateSendOnce(leadId, templateName) {
  if (!leadId || !templateName) return { claimed: true }; // nothing to check against — never block a send we can't verify
  const name = String(templateName).trim();
  try {
    const claimed = await Lead.findOneAndUpdate(
      { _id: leadId, "templateHistory.templateName": { $ne: name } },
      { $push: { templateHistory: { templateName: name, sentAt: new Date(), channel: "whatsapp", status: "pending", content: "" } } },
      { new: false }
    );
    return { claimed: !!claimed };
  } catch (e) {
    // A DB failure here must not silently permit an unlimited-duplicate send,
    // but it also must not be treated as "definitely already sent" (which
    // would blackhole every future send). Log and allow this one attempt
    // through — same fail-open philosophy as the old check.
    console.warn(`[autoTemplate] claimTemplateSendOnce failed: ${e.message} — allowing this send through`);
    return { claimed: true };
  }
}

async function releaseSendClaim(leadId, templateName) {
  if (!leadId || !templateName) return;
  try {
    await Lead.updateOne(
      { _id: leadId },
      { $pull: { templateHistory: { templateName: String(templateName).trim(), status: "pending" } } }
    );
  } catch (e) {
    console.warn(`[autoTemplate] releaseSendClaim failed: ${e.message}`);
  }
}

async function finalizeSendClaim(leadId, templateName, content = "") {
  if (!leadId || !templateName) return;
  const name = String(templateName).trim();
  try {
    await Lead.updateOne(
      { _id: leadId, "templateHistory.templateName": name, "templateHistory.status": "pending" },
      { $set: { "templateHistory.$.status": "sent", "templateHistory.$.content": content || "" } }
    );
  } catch (e) {
    console.warn(`[autoTemplate] finalizeSendClaim failed: ${e.message}`);
  }
}

async function recordTemplateHistory(lead, templateName, status = "sent", content = "") {
  try {
    if (!lead?._id || !templateName) return;
    await Lead.updateOne(
      { _id: lead._id },
      { $push: { templateHistory: { templateName: String(templateName).trim(), sentAt: new Date(), channel: "whatsapp", status, content: content || "" } } }
    );
  } catch (e) {
    // Never let a history-write failure break the send that already succeeded.
    console.error("[autoTemplate] templateHistory record error:", e.message);
  }
}

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

// ─── Templates that carry a MEDIA (document) header ──────────────────────────
// A document header is attached ONLY for these template names. Every other
// template (crm_call_*, crm_followup_reminder, crm_lead_not_interested, etc.)
// is header-less, and attaching a document to a header-less template makes
// Meta/MSG91 reject the send. Add a name here only if you created that MSG91
// template WITH a document header.
const TEMPLATES_WITH_DOC_HEADER = new Set([
  "crm_followup_leads",
]);


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
  let { templateName = "crm_followup_leads", languageCode = "en" } = whatsappSettings;

  // Auto-correct a configured static template that belongs to a DIFFERENT
  // industry/service than this lead — see resolveCorrectedTemplateForLead()
  // above. Previously this only BLOCKED the send (leaving the lead with
  // nothing), which was correct for safety but meant a misconfigured
  // Company.autoTemplate.whatsapp.templateName (e.g. accidentally set to
  // "digital_marketing_crm_awareness_v2") caused every OTHER lead to get
  // silently skipped rather than getting content actually relevant to them.
  // Now it resolves and sends the CORRECT name for this lead instead —
  // real industry×service template if tagged, service-matched niche if only
  // the service is known, general niche otherwise — so every lead gets
  // something relevant rather than either the wrong vertical or nothing.
  //
  // Safe for nurture's own auto-resolved sends too: those names are already
  // built from THIS SAME lead's industry/service, so resolveCorrectedTemplateForLead
  // always returns corrected:null for them (nothing to correct).
  const { corrected } = resolveCorrectedTemplateForLead(templateName, lead);
  if (corrected) {
    // Only send the corrected name if it's actually approved for this
    // company — a niche/industry template might not exist yet (e.g. still
    // pending MSG91 approval). Skip cleanly with a clear reason rather than
    // attempting a send that MSG91 would just reject. The ORIGINAL
    // (mismatched) name is never used as a fallback — sending the wrong
    // vertical's content is exactly what this whole correction step exists
    // to prevent.
    let correctedIsApproved = false;
    try {
      const cachedCorrected = await findTemplate(companyId, corrected);
      correctedIsApproved = !!cachedCorrected &&
        ["APPROVED", "ENABLED", "ACTIVE"].includes(String(cachedCorrected.status || "").toUpperCase());
    } catch {
      // Cache lookup failure — treat as not-yet-verified, skip rather than guess.
    }

    if (!correctedIsApproved) {
      console.warn(
        `[autoTemplate] ⚠️ Skipped — corrected template "${corrected}" for lead ${lead?._id} ` +
        `is not approved/synced yet in MSG91 (original configured value was "${templateName}"). ` +
        `Run the template sync, or create/approve this template in MSG91.`
      );
      return {
        channel: "whatsapp",
        status: "skipped",
        detail: `Correct template for this lead ("${corrected}") is not yet approved in MSG91.`,
      };
    }

    console.log(
      `[autoTemplate] 🔀 Auto-corrected template for lead ${lead?._id}: ` +
      `configured "${templateName}" → "${corrected}" (industry="${lead?.industry || "(none)"}", ` +
      `service="${lead?.service || "(none)"}")`
    );
    templateName = corrected;
  }

  // ── Permanent per-lead-per-template dedup — ATOMIC, applies to EVERY caller
  // See claimTemplateSendOnce() above for the full reasoning, including the
  // exact 5-duplicate-send race this replaces a non-atomic version of.
  //
  // IMPORTANT — placement: the actual claim() calls are made further below,
  // immediately before each provider's real network send attempt (MSG91 and
  // Meta each have their own), NOT here. Every check between here and there
  // (WhatsApp not configured, invalid phone, credentials missing, document
  // header misconfigured) can still legitimately return "skipped" — claiming
  // this early would push a permanent "pending" placeholder into
  // templateHistory for those cases too, and since none of them ever call
  // releaseSendClaim(), that placeholder would NEVER be cleared — permanently
  // blocking this exact template from ever being sent to this lead again,
  // even after the phone number or WhatsApp config gets fixed. The claim
  // must only happen once we know we're actually about to attempt delivery.

  // Attribution for the ONE log row this function writes on a successful
  // send. Each caller passes its own values so the report shows who/what
  // actually triggered the send instead of a hardcoded "New Lead" label —
  // e.g. nurtureSequenceJob.js passes channel="nurture" + the rule's
  // id/name, and no longer needs a second logging call of its own for the
  // "sent" case, which is what caused nurture sends to show up twice in the
  // WhatsApp send-log report.
  const {
    logChannel = "manual",
    logSentByName = "Auto-template (New Lead)",
    logRuleId = null,
    logRuleName = "",
  } = whatsappSettings;

  console.log(`[autoTemplate] WA → looking up WhatsAppConfig for company ${companyId}`);

  const config = await WhatsAppConfig.findOne({ company: companyId, isActive: true }).lean();
  if (!config) {
    console.warn(`[autoTemplate] ❌ WA skipped — no active WhatsAppConfig found for company ${companyId}`);
    return { channel: "whatsapp", status: "skipped", detail: "No active WhatsApp configuration. Connect WhatsApp in Communications → Integrations." };
  }

  const provider     = config.provider || "msg91";
  const authKey      = config.msg91AuthKey      || "";
  // integrated_number (the SENDER) must be the full international number that
  // is registered on MSG91 (e.g. "919591327778"). If the saved config value is
  // a bare 10-digit number, MSG91 rejects the send with 404 "WhatsApp not
  // integrated: 9591327778". normalizePhone() prepends 91 for 10-digit input
  // and is idempotent for already-prefixed numbers, so this is always correct.
  const senderNumber = normalizePhone(config.msg91IntegratedNumber || "");

  // ── Phone number for WhatsApp delivery ──────────────────────────────────────
  // normalizePhone() (defined at top of this file) already returns the full
  // international number WITH the 91 country code for a 10-digit input
  // (see: `if (digits.length === 10) digits = "91" + digits`). So we use its
  // result directly — prefixing "91" again would produce a broken
  // double-country-code number like 9191XXXXXXXXXX.
  const cleanPhone = normalizePhone(lead.mobile);
  if (!cleanPhone || cleanPhone.length < 10) {
    console.warn(`[autoTemplate] ❌ WA skipped — invalid phone: "${lead.mobile || ""}"`);
    return { channel: "whatsapp", status: "skipped", detail: `Lead has an invalid phone number ("${lead.mobile || ""}")` };
  }

  if (provider === "msg91") {
    if (!authKey || !senderNumber) {
      console.warn(`[autoTemplate] ❌ WA skipped — MSG91 credentials missing`);
      return { channel: "whatsapp", status: "skipped", detail: "MSG91 WhatsApp authkey / integrated number missing in WhatsApp settings." };
    }

    const namespace = config.msg91Namespace || "";

    // ── Document header — ONLY for templates that actually have one ────────────
    // WhatsApp rejects a send in TWO opposite ways:
    //   (a) a template WITH a document header, sent WITHOUT the document → 404;
    //   (b) a template WITHOUT a header, sent WITH a document component  → 400.
    // A single company-wide brochure URL was previously attached to EVERY
    // template, which meant enabling it (to fix crm_followup_leads) would break
    // the no-header templates (crm_call_*, crm_followup_reminder, etc.).
    // We now attach the document header ONLY to templates listed in
    // TEMPLATES_WITH_DOC_HEADER, and read the URL from the per-company config
    // with a DEFAULT_BROCHURE_URL env fallback (set it once in Render to cover
    // all companies without editing Mongo).
    const tmplName    = (templateName || "").trim();
    const needsDocHdr = TEMPLATES_WITH_DOC_HEADER.has(tmplName);
    const brochureUrl = needsDocHdr
      ? (config.msg91BrochureUrl || process.env.DEFAULT_BROCHURE_URL || "")
      : "";

    if (needsDocHdr && !brochureUrl) {
      console.warn(
        `[autoTemplate] ❌ WA skipped — template "${tmplName}" needs a document header ` +
        `but no brochure URL is set (WhatsAppConfig.msg91BrochureUrl / DEFAULT_BROCHURE_URL). ` +
        `MSG91 would reject this send with a 404. Set a public PDF URL, or switch this ` +
        `automation to a template without a document header.`
      );
      return {
        channel: "whatsapp",
        status:  "skipped",
        detail:  `Template "${tmplName}" requires a document header but no brochure URL is configured. ` +
                 `Set WhatsAppConfig.msg91BrochureUrl (or the DEFAULT_BROCHURE_URL env var) to a public PDF, ` +
                 `or use a template without a document header.`,
      };
    }

    // EXACT same component format as the proven-working chat/bulk sender:
    //   • body_1   → positional {{1}} body variable (the lead's name)
    //   • header_1 → document header, included ONLY when the template needs it
    const components = {
      ...(needsDocHdr && brochureUrl
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

    // ── {{2}} = the lead's BUSINESS name — ONLY when the template wants it ──
    // The 1,760 nurture templates declare TWO body variables ({{1}} contact,
    // {{2}} business). Older templates like crm_followup_leads declare only
    // {{1}}.
    //
    // Meta rejects a send whose parameter COUNT doesn't match the template, in
    // BOTH directions — too few and too many. So we look up how many variables
    // this specific template actually declares (cached by
    // services/msg91TemplateService.js) and attach body_2 only when it needs
    // one. If the template isn't in the cache yet we fall back to the name
    // pattern, since every nurture-library name ends in _<stage>_v<n>.
    let wantsBusinessName = false;
    try {
      const cached = await findTemplate(companyId, templateName.trim());
      if (cached) {
        wantsBusinessName = Number(cached.bodyVariableCount) >= 2;
      } else {
        wantsBusinessName = /_(awareness|interest|desire|action)_v\d+$/i.test(templateName.trim());
      }
    } catch (e) {
      // Cache lookup must never block a send — fall back to the name pattern.
      wantsBusinessName = /_(awareness|interest|desire|action)_v\d+$/i.test(templateName.trim());
    }

    if (wantsBusinessName) {
      components.body_2 = {
        type:  "text",
        value: (lead.businessName || "").trim() || "your business",
      };
    }

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

    // Claim right here — every earlier "skipped" return in this function has
    // already happened, so from this point on we are genuinely about to
    // attempt delivery. See the placement note above for why this can't live
    // any earlier.
    const { claimed: msg91Claimed } = await claimTemplateSendOnce(lead?._id, templateName);
    if (!msg91Claimed) {
      console.log(
        `[autoTemplate] ⛔ Skipped — template "${templateName}" was already sent to lead ${lead?._id} ` +
        `previously. Templates are never resent to the same lead once delivered.`
      );
      return {
        channel: "whatsapp",
        status: "skipped",
        detail: `Template "${templateName}" already sent to this lead previously — not resending.`,
      };
    }

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
        await releaseSendClaim(lead?._id, templateName); // send failed — free the claim so a future attempt can retry
        return { channel: "whatsapp", status: "failed", detail: `MSG91 rejected the message: ${detail}` };
      }
      // ── Resolve the actual rendered content, best-effort ────────────────
      // Real template body (with {{1}}/{{2}} filled in) when cached, else a
      // readable fallback built from the variables we actually sent — so
      // "Templates Sent" always shows something more useful than a bare name.
      const contentVars = { 1: components.body_1?.value || "" };
      if (components.body_2) contentVars[2] = components.body_2.value;
      const content = await resolveTemplateContent({
        companyId,
        templateName,
        variables: contentVars,
        fallbackText: wantsBusinessName
          ? `Message sent to ${components.body_1?.value || "the lead"} regarding ${components.body_2?.value || "their business"} (template: ${templateName})`
          : `Message sent to ${components.body_1?.value || "the lead"} (template: ${templateName})`,
      });
      await finalizeSendClaim(lead?._id, templateName, content); // finalize the atomic claim placeholder — never a second push
      void _logAutoTemplateSend({ lead, companyId, templateName, status: 'sent', detail: `Sent to ${cleanPhone} using template "${templateName}"`, content, channel: logChannel, sentByName: logSentByName, ruleId: logRuleId, ruleName: logRuleName });
      return { channel: "whatsapp", status: "sent", detail: `Sent to ${cleanPhone} using template "${templateName}"`, templateName, content };
    } catch (err) {
      const detail = JSON.stringify(err?.response?.data || err.message);
      console.error(`[autoTemplate] ❌ WA error:`, detail);
      await releaseSendClaim(lead?._id, templateName); // send failed — free the claim so a future attempt can retry
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

    // Claim right here — see the placement note above the MSG91 branch's
    // identical claim call for why this can't live any earlier in the function.
    const { claimed: metaClaimed } = await claimTemplateSendOnce(lead?._id, templateName);
    if (!metaClaimed) {
      console.log(
        `[autoTemplate] ⛔ Skipped — template "${templateName}" was already sent to lead ${lead?._id} ` +
        `previously. Templates are never resent to the same lead once delivered.`
      );
      return {
        channel: "whatsapp",
        status: "skipped",
        detail: `Template "${templateName}" already sent to this lead previously — not resending.`,
      };
    }

    try {
      const resp = await axios.post(apiUrl, metaPayload, {
        headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      });
      console.log(`[autoTemplate] ✅ WA Meta sent:`, JSON.stringify(resp.data));
      const content = await resolveTemplateContent({
        companyId,
        templateName,
        variables: { 1: lead.name || "" },
        fallbackText: `Message sent to ${lead.name || "the lead"} via Meta (template: ${templateName})`,
      });
      await finalizeSendClaim(lead?._id, templateName, content); // finalize the atomic claim placeholder — never a second push
      void _logAutoTemplateSend({ lead, companyId, templateName, status: 'sent', detail: `Sent to ${cleanPhone} via Meta using template "${templateName}"`, content, channel: logChannel, sentByName: logSentByName, ruleId: logRuleId, ruleName: logRuleName });
      return { channel: "whatsapp", status: "sent", detail: `Sent to ${cleanPhone} via Meta using template "${templateName}"`, templateName, content };
    } catch (err) {
      const detail = JSON.stringify(err?.response?.data || err.message);
      console.error(`[autoTemplate] ❌ WA Meta error:`, detail);
      await releaseSendClaim(lead?._id, templateName); // send failed — free the claim so a future attempt can retry
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

  // ── Source guard ────────────────────────────────────────────────────────────
  // Leads added manually or imported from CSV/Excel must NOT receive any
  // automated WhatsApp / Email / SMS messages. Only leads that arrive via
  // Meta, Google, or Website webhooks (organic / campaign sources) should
  // trigger the crm_followup_leads template.
  const blockedSources = new Set(["manual", "csv import", "excel import", "other"]);
  const leadSource = String(lead.source || "").toLowerCase().trim();
  const isImported = lead.importedViaCsv === true;
  if (isImported || blockedSources.has(leadSource)) {
    console.log(`[autoTemplate] ⏭ Skipped — source="${lead.source}" (manual/imported leads are excluded from automation)`);
    return [{ channel: "all", status: "skipped", detail: `Source "${lead.source}" is excluded from automation` }];
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
  // Exported so other send paths that don't go through sendAutoWhatsApp()
  // (e.g. whatsappChatController.js's manual bulk-blast endpoint) can share
  // the exact same "never send the same template to the same lead twice"
  // atomic guarantee, instead of duplicating this logic.
  claimTemplateSendOnce,
  releaseSendClaim,
  finalizeSendClaim,
};
