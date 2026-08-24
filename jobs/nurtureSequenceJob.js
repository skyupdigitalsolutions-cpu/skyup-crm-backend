// jobs/nurtureSequenceJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Lead nurture sequences — status-driven, sequential variation rotation.
//
// TRIGGERS:
//   1. Immediate — triggerNurtureForLead(leadId, newStatus) called from
//      leadController.js on every status change. Fires V1 (or next variation)
//      instantly when a lead enters a new status stage.
//   2. Cron — 11:00 AM IST daily. Re-fires for leads still stuck in the same
//      status after repeatEveryDays days with no movement.
//
// STAGE → STATUS MAPPING (per rule's statusStage field):
//   New         → Awareness  (every 3 days repeat)
//   In Progress → Interest   (every 2 days repeat)
//   Interest    → Desire     (every 2 days repeat)
//   Converted   → Action     (every 1 day repeat)
//
// VARIATION LOGIC (sequential per lead per stage):
//   Each lead tracks lastVariationIndex per rule in lead.nurtureSent.
//   When stage changes (status moves to a new statusStage), index resets to -1
//   so V1 fires first. Otherwise increments: V1→V2→V3→V4→V5→V1→...
//
// COMPANY GATE:
//   Only runs for company 6a22662b7aea6e4034f44aae (SkyUp Digital Solutions).
//   Every other company is silently skipped.
// ─────────────────────────────────────────────────────────────────────────────

const cron        = require("node-cron");
const Lead        = require("../models/Leads");
const Company     = require("../models/Company");
const NurtureRule = require("../models/NurtureRule");
const WhatsAppSendLog = require("../models/WhatsAppSendLog");
const { sendAutoWhatsApp } = require("../services/autoTemplateService");
const { resolveForLead, canResolve } = require("../utils/templateNameResolver");
const { findTemplate } = require("../services/msg91TemplateService");
const WhatsAppTemplate = require("../models/WhatsAppTemplate");

const IST_TIMEZONE = "Asia/Kolkata";

// ── Single company gate ───────────────────────────────────────────────────────
const ENABLED_COMPANY_ID = "6a22662b7aea6e4034f44aae";

// "Not Interested" leads are hard-skipped globally — never receive nurture messages.
// "Converted" is NOT skipped here; it can still receive Action-stage messages
// when a rule's statusStage = "Converted". The per-rule statusStage filter
// in ruleMatchesStatus() handles the finer gating.
const HARD_SKIP_STATUSES = new Set(["Not Interested"]);

// Sources that never receive nurture messages
const BLOCKED_SOURCES = new Set(["manual", "csv import", "excel import", "other"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function istDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIMEZONE,
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayDiffKeys(k1, k2) {
  if (!k1 || !k2) return Infinity;
  const [y1, m1, d1] = String(k1).split("-").map(Number);
  const [y2, m2, d2] = String(k2).split("-").map(Number);
  if ([y1, m1, d1, y2, m2, d2].some((n) => !Number.isFinite(n))) return Infinity;
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function lastTouchDate(lead) {
  const history = Array.isArray(lead.callHistory) ? lead.callHistory : [];
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last?.calledAt) return new Date(last.calledAt);
  }
  return new Date(lead.date);
}

function daysSince(date, now) {
  return Math.floor((now.getTime() - new Date(date).getTime()) / 86400000);
}

function isManualOrImported(lead) {
  return !!(
    lead.importedViaCsv === true ||
    lead.addedManually === true ||
    BLOCKED_SOURCES.has(String(lead.source || "").toLowerCase().trim())
  );
}

// ── Variation picker ──────────────────────────────────────────────────────────
// Returns the next template name in the sequence for this rule + lead.
// Resets to index 0 (V1) when the lead's current status doesn't match
// the stage the rule last fired for — meaning the lead moved to a new stage.

// Shared variation bookkeeping — used by BOTH the auto-resolve mode and the
// manual templateVariations list. Returns the 0-based index of the next
// variation to send, cycling V1→V2→…→V{count}→V1 and resetting to V1 whenever
// the lead has moved to a different status stage since this rule last fired.
function nextVariationIndex(rule, lead, count) {
  const ruleId = String(rule._id);
  const sentMap = lead.nurtureSent instanceof Map
    ? lead.nurtureSent
    : new Map(Object.entries(lead.nurtureSent || {}));

  const entry = sentMap.get(ruleId);

  let lastIndex = -1;
  let lastStage = null;
  if (entry && typeof entry === "object") {
    lastIndex = typeof entry.lastVariationIndex === "number" ? entry.lastVariationIndex : -1;
    lastStage = entry.stage || null;
  }

  const currentStage = lead.status || "";
  const ruleStage    = rule.action?.whatsapp?.statusStage || "";
  if (lastStage && ruleStage && lastStage !== currentStage) {
    lastIndex = -1; // lead moved stage → restart at V1
  }

  return (lastIndex + 1) % Math.max(1, count);
}

function resolveNextVariation(rule, lead) {
  const wa = rule.action?.whatsapp || {};

  // ── AUTO-RESOLVE MODE (1,760-template library) ──────────────────────────
  // Build the template name from the lead's own industry + service instead of
  // reading a hardcoded list. Still cycles V1→V5 and resets on stage change,
  // so the variation bookkeeping below is shared by both modes.
  const autoMode = !!wa.autoResolveTemplate && !!wa.funnelStage;
  if (autoMode) {
    if (!canResolve(lead)) {
      // Lead has no industry/service — cannot auto-resolve. Try templateVariations
      // first, then fall back to the single templateName on the rule. Auto-resolve
      // rules typically have an empty templateVariations, so the single templateName
      // acts as the last-resort generic fallback for untagged leads.
      console.warn(
        `[NurtureJob] lead ${lead._id} missing industry/service — ` +
        `cannot auto-resolve "${wa.funnelStage}" template; falling back to templateVariations/templateName`
      );
      // fall through to the variation / single-template block below
    } else {
      const count = Math.max(1, Number(wa.variationCount) || 5);
      const idx   = nextVariationIndex(rule, lead, count);
      const templateName = resolveForLead(lead, wa.funnelStage, idx + 1);
      return { templateName, nextIndex: idx, autoResolved: true };
    }
  }

  const variations = wa.templateVariations;
  if (!Array.isArray(variations) || variations.length === 0) {
    // No variation list — use the single fallback templateName on the rule.
    // For auto-resolve rules with untagged leads this is the last resort;
    // set action.whatsapp.templateName on the rule to a generic template
    // (e.g. "generic_awareness_v1") so these leads still get nurtured.
    return { templateName: wa.templateName || "", nextIndex: 0 };
  }

  const ruleId = String(rule._id);
  const sentMap = lead.nurtureSent instanceof Map
    ? lead.nurtureSent
    : new Map(Object.entries(lead.nurtureSent || {}));

  const entry = sentMap.get(ruleId);

  // entry can be:
  //   undefined  — never fired
  //   string     — old format (plain date string), treat as never fired for index
  //   object     — { lastFiredDate, lastVariationIndex, stage }
  let lastIndex = -1;
  let lastStage = null;

  if (entry && typeof entry === "object") {
    lastIndex = typeof entry.lastVariationIndex === "number" ? entry.lastVariationIndex : -1;
    lastStage = entry.stage || null;
  }

  // If lead moved to a different status stage since last fire → reset to V1
  const currentStage = lead.status || "";
  const ruleStage    = rule.action?.whatsapp?.statusStage || "";
  if (lastStage && ruleStage && lastStage !== currentStage) {
    lastIndex = -1; // reset
  }

  const nextIndex    = (lastIndex + 1) % variations.length;
  const templateName = variations[nextIndex];
  return { templateName, nextIndex };
}

// ── Rule matching ─────────────────────────────────────────────────────────────
// For cron runs: checks idle days threshold.
// For immediate (status-change) runs: skips idle check.

function ruleMatchesStatus(rule, lead) {
  if (HARD_SKIP_STATUSES.has(lead.status)) return false;
  if (isManualOrImported(lead)) return false;

  const t = rule.trigger || {};
  const statusStage = rule.action?.whatsapp?.statusStage || "";

  // Rule only fires for the status it's configured for
  if (statusStage && lead.status !== statusStage) return false;

  // Additional trigger filters
  if (Array.isArray(t.statuses) && t.statuses.length && !t.statuses.includes(lead.status)) return false;
  if (Array.isArray(t.temperatures) && t.temperatures.length && !t.temperatures.includes(lead.temperature)) return false;

  // ── Domain-wise industry filter ─────────────────────────────────────────
  // Empty list = fire for any industry (including untagged leads).
  // Compared case-insensitively so "real estate" from the app still matches
  // the canonical "Real Estate" chip stored on the rule.
  if (Array.isArray(t.industries) && t.industries.length) {
    const leadIndustry = String(lead.industry || "").trim().toLowerCase();
    if (!leadIndustry) return false; // rule targets specific industries; untagged lead can't match
    const wanted = t.industries.map((x) => String(x || "").trim().toLowerCase());
    if (!wanted.includes(leadIndustry)) return false;
  }

  // ── Campaign filter ─────────────────────────────────────────────────────
  // When campaigns list is set on the rule, only fire for leads whose
  // lead.campaign matches one of those campaign names (case-insensitive).
  if (Array.isArray(t.campaigns) && t.campaigns.length) {
    const leadCampaign = String(lead.campaign || "").trim().toLowerCase();
    if (!leadCampaign) return false; // rule targets specific campaigns; untagged lead can't match
    const wanted = t.campaigns.map((c) => String(c || "").trim().toLowerCase());
    if (!wanted.includes(leadCampaign)) return false;
  }

  // ── Ad-Set filter ─────────────────────────────────────────────────────────
  // Narrower than campaign — filter by specific ad set name.
  if (Array.isArray(t.adSets) && t.adSets.length) {
    const leadAdSet = String(lead.adSetName || "").trim().toLowerCase();
    if (!leadAdSet) return false;
    const wanted = t.adSets.map((a) => String(a || "").trim().toLowerCase());
    if (!wanted.includes(leadAdSet)) return false;
  }

  return true;
}

function ruleMatchesCron(rule, lead, now) {
  if (!ruleMatchesStatus(rule, lead)) return false;

  const t = rule.trigger || {};
  const idle = daysSince(lastTouchDate(lead), now);
  if (idle < (t.minDaysSinceLastTouch ?? Infinity)) return false;

  return true;
}

// Has this rule already fired today for this lead?
function alreadyFiredToday(rule, lead, todayKey) {
  const sentMap = lead.nurtureSent instanceof Map
    ? lead.nurtureSent
    : new Map(Object.entries(lead.nurtureSent || {}));

  const entry = sentMap.get(String(rule._id));
  if (!entry) return false;

  const lastFired = typeof entry === "string" ? entry : entry?.lastFiredDate;
  return lastFired === todayKey;
}

// Is the rule eligible to re-fire (for cron repeat)?
function eligibleForRepeat(rule, lead, todayKey) {
  const sentMap = lead.nurtureSent instanceof Map
    ? lead.nurtureSent
    : new Map(Object.entries(lead.nurtureSent || {}));

  const entry = sentMap.get(String(rule._id));
  if (!entry) return true; // never fired — eligible

  const lastFired = typeof entry === "string" ? entry : entry?.lastFiredDate;
  if (!lastFired) return true;

  if (!rule.repeatEveryDays) return false; // one-shot rule already fired
  return dayDiffKeys(lastFired, todayKey) >= rule.repeatEveryDays;
}

// ── Fire a rule for a lead ────────────────────────────────────────────────────

// Persist the outcome so the "sent template report" (WhatsApp send-log) shows
// nurture sends alongside manual blasts — previously this only ever produced
// a console.log line that vanished into server logs.
async function _logNurtureResult(lead, rule, result) {
  try {
    await WhatsAppSendLog.create({
      company: lead.company,
      lead: lead._id,
      phone: lead.mobile || "",
      name: lead.name || "",
      templateName: result.templateName || "",
      languageCode: "en",
      channel: "nurture",
      status: result.status === "sent" ? "sent" : result.status === "skipped" ? "skipped" : "failed",
      reason: result.detail || "",
      sentByName: "Nurture automation",
      ruleId: rule._id,
      ruleName: rule.name || "",
    });
  } catch (err) {
    console.error("[nurtureSequence] failed to write send-log entry:", err.message);
  }
}

// ── Belt-and-suspenders dedup: check templateHistory ─────────────────────────
// If autoSendTemplates sent this template today before nurtureSent was stamped,
// check templateHistory as a fallback guard.
async function alreadySentViaTemplateHistory(leadId, rule, todayKey) {
  try {
    const templateName = rule.action?.whatsapp?.templateName || "";
    const variations   = rule.action?.whatsapp?.templateVariations || [];
    const allTemplates = [templateName, ...variations].filter(Boolean);
    if (!allTemplates.length) return false;

    const [y, m, d] = todayKey.split("-").map(Number);
    const todayStart = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const todayEnd   = new Date(Date.UTC(y, m - 1, d, 18, 29, 59, 999)); // end of IST day in UTC

    const lead = await Lead.findOne(
      { _id: leadId, "templateHistory.sentAt": { $gte: todayStart, $lte: todayEnd },
        "templateHistory.templateName": { $in: allTemplates } },
      { _id: 1 }
    ).lean();
    return !!lead;
  } catch {
    return false;
  }
}

async function fireRule(rule, lead, company, todayKey) {
  if (!lead.mobile) {
    return { status: "skipped", detail: "Lead has no mobile number" };
  }
  if (!rule.action?.whatsapp?.enabled) {
    return { status: "skipped", detail: "WhatsApp not enabled on rule" };
  }

  const { templateName, nextIndex, autoResolved } = resolveNextVariation(rule, lead);
  if (!templateName) {
    return { status: "skipped", detail: "No template name resolved" };
  }

  // ── Verify the template actually exists in MSG91 before spending a send ──
  // Only for auto-resolved names: those are BUILT from the lead's industry +
  // service, so a vertical with no approved templates would otherwise produce
  // a plausible-looking name that Meta rejects. Checking the synced cache
  // turns that into a clear log line instead of a failed message.
  //
  // If the cache is empty (never synced), we skip the check rather than block
  // every send — run POST /api/nurture/templates/sync to enable verification.
  if (autoResolved) {
    try {
      const cached = await findTemplate(lead.company, templateName);
      if (cached) {
        const st = String(cached.status || "").toUpperCase();
        if (st && st !== "APPROVED" && st !== "ENABLED" && st !== "ACTIVE") {
          console.warn(`[NurtureJob] template "${templateName}" is ${st} — skipping lead ${lead._id}`);
          return { status: "skipped", detail: `Template not approved (${st})` };
        }
      } else {
        const anySynced = await WhatsAppTemplate.countDocuments({ company: lead.company }).catch(() => 0);
        if (anySynced > 0) {
          console.warn(
            `[NurtureJob] template "${templateName}" not found in synced MSG91 list — ` +
            `skipping lead ${lead._id} (industry="${lead.industry}" service="${lead.service}")`
          );
          return { status: "skipped", detail: `Template "${templateName}" does not exist in MSG91` };
        }
        // No sync has ever run — proceed and let MSG91 be the judge.
      }
    } catch (e) {
      console.warn(`[NurtureJob] template verification failed (${e.message}) — proceeding`);
    }
  }

  // Atomic claim — prevent double-send on overlapping ticks
  const fieldPath = `nurtureSent.${rule._id}`;
  const claimed = await Lead.findOneAndUpdate(
    {
      _id: lead._id,
      $or: [
        { [fieldPath]: { $exists: false } },
        { [`${fieldPath}.lastFiredDate`]: { $ne: todayKey } },
        { [fieldPath]: { $not: { $eq: todayKey } } }, // handles old string format
      ],
    },
    {
      $set: {
        [fieldPath]: {
          lastFiredDate:      todayKey,
          lastVariationIndex: nextIndex,
          stage:              lead.status || "",
        },
      },
    },
    { new: false }
  );

  if (!claimed) {
    return { status: "skipped", detail: "Already fired today (atomic claim lost)" };
  }

  const result = await sendAutoWhatsApp({
    companyId:        company._id,
    lead,
    whatsappSettings: {
      ...rule.action.whatsapp,
      templateName,
      languageCode: rule.action.whatsapp.languageCode || "en",
    },
  }).catch((err) => ({ channel: "whatsapp", status: "failed", detail: err.message }));

  const sent = result?.status === "sent";

  if (!sent) {
    // Release claim so a fixed config can retry
    await Lead.updateOne(
      { _id: lead._id },
      { $unset: { [fieldPath]: "" } }
    ).catch(() => {});
    return { status: "failed", detail: result?.detail || "Send failed", templateName };
  }

  console.log(
    `[nurtureSequence] rule "${rule.name}" → lead ${lead._id} ("${lead.name}") ` +
    `status="${lead.status}" template="${templateName}" (V${nextIndex + 1})`
  );

  return { status: "sent", templateName, variationIndex: nextIndex + 1 };
}

// ── Cron run ──────────────────────────────────────────────────────────────────

async function runNurtureSequenceCheck() {
  const now      = new Date();
  const todayKey = istDayKey(now);

  // Company gate — only SkyUp Digital Solutions
  const company = await Company.findById(ENABLED_COMPANY_ID).select("name _id").lean();
  if (!company) {
    console.log(`[nurtureSequence] Company ${ENABLED_COMPANY_ID} not found — skipping.`);
    return { sent: 0 };
  }

  const rules = await NurtureRule.find({ company: ENABLED_COMPANY_ID, enabled: true }).lean();
  if (!rules.length) {
    console.log("[nurtureSequence] No enabled rules — skipping.");
    return { sent: 0 };
  }

  const leads = await Lead.find({
    company:    ENABLED_COMPANY_ID,
    isClosed:   { $ne: true },
    status:     { $nin: ["Not Interested"] },
    mergedInto: null,
  })
    .select("name mobile company status temperature source date callHistory importedViaCsv addedManually nurtureSent user industry service businessName campaign adSetName")
    .lean();

  let totalSent = 0;

  for (const lead of leads) {
    for (const rule of rules) {
      if (!ruleMatchesCron(rule, lead, now))  continue;
      if (!eligibleForRepeat(rule, lead, todayKey)) continue;
      if (alreadyFiredToday(rule, lead, todayKey))  continue;
      // DEDUP FIX: belt-and-suspenders check against templateHistory
      if (await alreadySentViaTemplateHistory(lead._id, rule, todayKey)) continue;

      const result = await fireRule(rule, lead, company, todayKey);
      _logNurtureResult(lead, rule, result); // fire-and-forget, never blocks the cron loop
      if (result.status === "sent") totalSent++;
    }
  }

  if (totalSent) {
    console.log(`[nurtureSequence] Cron run complete — sent ${totalSent} message(s).`);
  }
  return { sent: totalSent };
}

// ── Immediate trigger (called from leadController on status change) ────────────
// Fires V1 (or next in sequence) immediately when a lead's status changes.

async function triggerNurtureForLead(leadId, newStatus) {
  if (!newStatus || HARD_SKIP_STATUSES.has(newStatus)) return;

  const todayKey = istDayKey();

  const lead = await Lead.findOne({
    _id:        leadId,
    company:    ENABLED_COMPANY_ID,
    isClosed:   { $ne: true },
    mergedInto: null,
  })
    .select("name mobile company status temperature source date callHistory importedViaCsv addedManually nurtureSent user industry service businessName campaign adSetName")
    .lean();

  if (!lead) return; // not this company's lead, or not found

  // Use newStatus (the incoming value) for stage matching since the DB may
  // not yet reflect the update when this fires
  const leadWithNewStatus = { ...lead, status: newStatus };

  if (isManualOrImported(leadWithNewStatus)) return;

  const rules = await NurtureRule.find({ company: ENABLED_COMPANY_ID, enabled: true }).lean();
  const company = await Company.findById(ENABLED_COMPANY_ID).select("name _id").lean();
  if (!company) return;

  for (const rule of rules) {
    if (!ruleMatchesStatus(rule, leadWithNewStatus)) continue;
    if (alreadyFiredToday(rule, leadWithNewStatus, todayKey)) continue;
    // DEDUP FIX: skip if autoSendTemplates already sent this exact template today
    // (autoSendTemplates now stamps nurtureSent, but this is a belt-and-suspenders
    //  check for any edge cases where the stamp didn't land in time)
    if (await alreadySentViaTemplateHistory(leadWithNewStatus._id, rule, todayKey)) continue;

    const result = await fireRule(rule, leadWithNewStatus, company, todayKey);
    _logNurtureResult(leadWithNewStatus, rule, result); // fire-and-forget
    if (result.status === "sent") {
      console.log(
        `[nurtureSequence] Immediate trigger — lead ${leadId} status→"${newStatus}" ` +
        `template="${result.templateName}"`
      );
    }
  }
}

// ── Cron scheduler ────────────────────────────────────────────────────────────

function startNurtureSequenceJob() {
  // 11:00 AM IST daily — after morning follow-up reminder (9:30 AM)
  cron.schedule(
    "0 11 * * *",
    () => {
      runNurtureSequenceCheck().catch((e) =>
        console.error("[nurtureSequence] job error:", e.message)
      );
    },
    { timezone: IST_TIMEZONE }
  );

  console.log("✅ Nurture sequence job started (11:00 AM IST daily, company 6a22662b7aea6e4034f44aae).");
}

module.exports = { startNurtureSequenceJob, runNurtureSequenceCheck, triggerNurtureForLead, NURTURE_COMPANY_ID: ENABLED_COMPANY_ID };
