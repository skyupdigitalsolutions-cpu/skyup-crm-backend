// jobs/nurtureSequenceJob.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Time-triggered lead nurture. Unlike services/outcomeAutomationService.js
// (fires once, right when an agent logs a call outcome), this fires because
// N days have passed with NO movement on a lead — the actual gap that lets
// leads go cold between manual follow-ups.
//
// STRICT SINGLE-COMPANY ROLLOUT:
//   Only ever processes leads for companies where
//   company.devOverrides.featureToggles.leadNurtureSequence === true.
//   Every other company is skipped entirely, every run — see
//   getEnabledCompanyIds() below. This is enforced here (not just hidden in
//   the UI) so enabling it for Client A can never touch Client B's leads.
//
// Rules live in models/NurtureRule.js, one company can have many. Each rule:
//   • matches on status / temperature / days-since-last-touch / source
//   • sends WhatsApp + Email to the LEAD (reusing autoTemplateService.js —
//     the same MSG91/Meta + MSG91→Brevo senders as every other automation)
//   • dedupes via Lead.nurtureSent (ruleId → last-fired IST day key), so a
//     15-min job tick never double-sends
//
// HOW TO ACTIVATE — wire into server.js:
//   const { startNurtureSequenceJob } = require('./jobs/nurtureSequenceJob');
//   startNurtureSequenceJob();
// ─────────────────────────────────────────────────────────────────────────────

const cron       = require("node-cron");
const Lead       = require("../models/Leads");
const Company    = require("../models/Company");
const NurtureRule = require("../models/NurtureRule");
const { sendAutoWhatsApp, sendAutoEmail } = require("../services/autoTemplateService");

const IST_TIMEZONE = "Asia/Kolkata";

// Sources that never receive nurture messages unless a rule explicitly opts
// them in via trigger.includeManualOrImported — mirrors the same guard in
// services/outcomeAutomationService.js so behavior stays consistent across
// every automation in the CRM.
const BLOCKED_SOURCES = new Set(["manual", "csv import", "excel import", "other"]);

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
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86400000);
}

// Last real interaction on a lead: last callHistory.calledAt, else lead.date.
function lastTouchDate(lead) {
  const history = Array.isArray(lead.callHistory) ? lead.callHistory : [];
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last?.calledAt) return new Date(last.calledAt);
  }
  return new Date(lead.date);
}

function daysSince(date, now) {
  const ms = now.getTime() - new Date(date).getTime();
  return Math.floor(ms / 86400000);
}

function isManualOrImported(lead) {
  return !!(
    lead.importedViaCsv === true ||
    lead.addedManually === true ||
    BLOCKED_SOURCES.has(String(lead.source || "").toLowerCase().trim())
  );
}

// ── Only companies explicitly opted in — the single-company gate ────────────
async function getEnabledCompanyIds() {
  const companies = await Company.find({
    "devOverrides.featureToggles.leadNurtureSequence": true,
  }).select("_id").lean();
  return companies.map((c) => String(c._id));
}

function ruleMatches(rule, lead, now) {
  const t = rule.trigger || {};

  if (Array.isArray(t.statuses) && t.statuses.length && !t.statuses.includes(lead.status)) return false;
  if (Array.isArray(t.temperatures) && t.temperatures.length && !t.temperatures.includes(lead.temperature)) return false;

  if (Array.isArray(t.sources) && t.sources.length) {
    if (!t.sources.map((s) => s.toLowerCase()).includes(String(lead.source || "").toLowerCase())) return false;
  }

  if (!t.includeManualOrImported && isManualOrImported(lead)) return false;

  if (t.requirePendingFollowUp) {
    const hasPending = (lead.scheduledCalls || []).some((c) => c.done === false);
    if (!hasPending) return false;
  }

  const idle = daysSince(lastTouchDate(lead), now);
  if (idle < (t.minDaysSinceLastTouch ?? Infinity)) return false;

  return true;
}

// Has this rule already fired for this lead, and is it eligible to re-fire?
function eligibleToFire(rule, lead, todayKey) {
  const sentMap = lead.nurtureSent instanceof Map
    ? lead.nurtureSent
    : new Map(Object.entries(lead.nurtureSent || {}));
  const lastFired = sentMap.get(String(rule._id));

  if (!lastFired) return true; // never fired — eligible
  if (!rule.repeatEveryDays) return false; // one-shot rule, already fired

  return dayDiffKeys(lastFired, todayKey) >= rule.repeatEveryDays;
}

async function fireRule(rule, lead, company) {
  const results = [];
  const action = rule.action || {};

  if (action.whatsapp?.enabled) {
    if (lead.mobile) {
      const r = await sendAutoWhatsApp({
        companyId: company._id,
        lead,
        whatsappSettings: action.whatsapp,
      }).catch((err) => ({ channel: "whatsapp", status: "failed", detail: err.message }));
      results.push(r);
    } else {
      results.push({ channel: "whatsapp", status: "skipped", detail: "Lead has no mobile number" });
    }
  }

  if (action.email?.enabled) {
    if (lead.email) {
      const r = await sendAutoEmail({
        companyId: company._id,
        lead,
        emailSettings: action.email,
      }).catch((err) => ({ channel: "email", status: "failed", detail: err.message }));
      results.push(r);
    } else {
      results.push({ channel: "email", status: "skipped", detail: "Lead has no email address" });
    }
  }

  // Internal agent ping — best-effort, socket only (no FCM push wired yet).
  // Hook into services/fcmService.js here later if a push notification is
  // wanted for this instead of/in addition to the socket event.
  if (action.notifyAgent && lead.user) {
    try {
      const _io = global._io;
      if (_io) {
        _io.to(`user:${lead.user}`).emit("nurture_alert", {
          leadId: String(lead._id),
          leadName: lead.name,
          message: action.notifyAgentMessage || `"${lead.name}" needs attention — no movement in a while.`,
          timestamp: new Date().toISOString(),
        });
      }
      results.push({ channel: "agent_notify", status: "sent" });
    } catch (err) {
      results.push({ channel: "agent_notify", status: "failed", detail: err.message });
    }
  }

  return results;
}

async function runNurtureSequenceCheck() {
  const now      = new Date();
  const todayKey = istDayKey(now);

  const companyIds = await getEnabledCompanyIds();
  if (!companyIds.length) {
    console.log("[nurtureSequence] No company has leadNurtureSequence enabled — skipping run.");
    return { companies: 0, sent: 0 };
  }

  let totalSent = 0;
  const details = [];

  for (const companyId of companyIds) {
    const rules = await NurtureRule.find({ company: companyId, enabled: true }).lean();
    if (!rules.length) continue;

    const companyDoc = await Company.findById(companyId).select("name");
    const company = companyDoc ? companyDoc.toObject() : { _id: companyId, name: "" };

    // Only fetch leads that are still active — closed/converted/merged leads
    // never need nurturing.
    const leads = await Lead.find({
      company: companyId,
      isClosed: { $ne: true },
      status: { $nin: ["Converted", "Not Interested"] },
      mergedInto: null,
    })
      .select("name mobile email company status temperature source date callHistory scheduledCalls importedViaCsv addedManually nurtureSent user")
      .lean();

    for (const lead of leads) {
      for (const rule of rules) {
        if (!ruleMatches(rule, lead, now)) continue;
        if (!eligibleToFire(rule, lead, todayKey)) continue;

        // Atomic claim — same pattern as outcomeAutomationService.js — so an
        // overlapping tick can never double-send this rule to this lead today.
        const fieldPath = `nurtureSent.${rule._id}`;
        const claimed = await Lead.findOneAndUpdate(
          { _id: lead._id, [fieldPath]: { $ne: todayKey } },
          { $set: { [fieldPath]: todayKey } },
          { new: false }
        );
        if (!claimed) continue;

        const results = await fireRule(rule, lead, company);
        const anySent = results.some((r) => r.status === "sent");
        if (!anySent) {
          // Nothing actually sent (bad config etc.) — release the claim so a
          // fixed config can retry later, same release-on-failure pattern.
          await Lead.updateOne({ _id: lead._id }, { $unset: { [fieldPath]: "" } }).catch(() => {});
          continue;
        }

        totalSent++;
        details.push({ leadId: String(lead._id), leadName: lead.name, rule: rule.name, company: company.name, results });
        console.log(`[nurtureSequence] rule "${rule.name}" fired for lead ${lead._id} ("${lead.name}"):`, JSON.stringify(results));
      }
    }
  }

  if (totalSent) console.log(`[nurtureSequence] Sent ${totalSent} nurture message(s) across ${companyIds.length} enabled compan${companyIds.length > 1 ? "ies" : "y"}.`);
  return { companies: companyIds.length, sent: totalSent, details };
}

function startNurtureSequenceJob() {
  // Once daily, 11:00 AM IST — after the morning follow-up reminder (9:30 AM)
  // so a lead isn't double-nudged by two different jobs within minutes.
  cron.schedule(
    "0 11 * * *",
    () => {
      runNurtureSequenceCheck().catch((e) => console.error("[nurtureSequence] job error:", e.message));
    },
    { timezone: IST_TIMEZONE }
  );

  console.log("✅ Nurture sequence job started (11:00 AM IST daily, company-gated).");
}

module.exports = { startNurtureSequenceJob, runNurtureSequenceCheck };
