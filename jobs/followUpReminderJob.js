// jobs/followUpReminderJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Sends a WhatsApp + Email reminder DIRECTLY TO THE LEAD whenever they have a
// pending (not done) scheduledCalls entry of type "follow-up" that is due
// today or overdue.
//
//   • No SMS — WhatsApp + Email only (by design).
//   • Fires TWICE a day: 9:30 AM and 8:30 PM IST.
//   • Each lead gets at most ONE reminder per slot per calendar day (IST) —
//     tracked via followUpReminderLastSentDate / followUpReminderLastSentSlot
//     on the Lead document, so a job retry / overlapping tick never
//     double-sends.
//   • Uses the company's `followUpReminder` settings (WhatsApp template +
//     Email subject/body) — same shape as autoTemplate / interestedBlast,
//     enabled by default so this works out of the box.
//   • Reuses the exact same WhatsApp (MSG91/Meta) + Email (MSG91→Brevo)
//     sending logic already used for new-lead and Interested-lead blasts, via
//     services/autoTemplateService.js — no duplicated provider code.
//   • Stops automatically once the follow-up is marked done, the lead is
//     closed, or the lead is Converted — because the query only ever matches
//     leads with a still-pending "follow-up" scheduledCalls entry.
//
// HOW TO ACTIVATE — wired in server.js:
//   const { startFollowUpReminderJob } = require('./jobs/followUpReminderJob');
//   startFollowUpReminderJob();
// ─────────────────────────────────────────────────────────────────────────────

const cron    = require("node-cron");
const Lead    = require("../models/Leads");
const Company = require("../models/Company");
const { sendAutoWhatsApp, sendAutoEmail } = require("../services/autoTemplateService");
const custSvc = require("../services/customizationService");

const IST_TIMEZONE = "Asia/Kolkata";

// How many days between reminder cycles. Default 3 (was effectively 1 = daily).
// Override with env FOLLOWUP_REMINDER_INTERVAL_DAYS if you ever want a different
// cadence without a code change.
const REMINDER_INTERVAL_DAYS = Number(process.env.FOLLOWUP_REMINDER_INTERVAL_DAYS) || 3;

// ── Whole-day difference between two IST day keys ("YYYY-M-D"). ──────────────
// Returns k2 - k1 in days (positive when k2 is later). Used to decide whether a
// lead's 3-day reminder cycle has elapsed.
function dayDiffKeys(k1, k2) {
  if (!k1 || !k2) return Infinity;
  const [y1, m1, d1] = String(k1).split("-").map(Number);
  const [y2, m2, d2] = String(k2).split("-").map(Number);
  if ([y1, m1, d1, y2, m2, d2].some((n) => !Number.isFinite(n))) return Infinity;
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86400000);
}

// ── IST calendar-day key, e.g. "2026-7-3" — used purely for same-day dedupe ──
function istDayKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIMEZONE,
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ── End of "today" in IST, expressed as a UTC Date, for the $lte query ──────
function istTodayEnd(date) {
  const key = istDayKey(date); // "YYYY-M-D" in IST
  const [y, m, d] = key.split("-").map(Number);
  // 23:59:59.999 IST == 18:29:59.999 UTC same day (IST is UTC+5:30)
  return new Date(Date.UTC(y, m - 1, d, 18, 29, 59, 999));
}

// ── Send WA + Email for one lead's follow-up reminder. Never throws. ────────
async function fireFollowUpReminder(lead, company) {
  const settings = company.followUpReminder || {};
  const results = [];

  if (settings.whatsapp?.enabled) {
    if (lead.mobile) {
      const r = await sendAutoWhatsApp({
        companyId: company._id,
        lead,
        whatsappSettings: settings.whatsapp,
      }).catch((err) => ({ channel: "whatsapp", status: "failed", detail: err.message }));
      results.push(r);
    } else {
      results.push({ channel: "whatsapp", status: "skipped", detail: "Lead has no mobile number" });
    }
  }

  if (settings.email?.enabled) {
    if (lead.email) {
      const r = await sendAutoEmail({
        companyId: company._id,
        lead,
        emailSettings: settings.email,
      }).catch((err) => ({ channel: "email", status: "failed", detail: err.message }));
      results.push(r);
    } else {
      results.push({ channel: "email", status: "skipped", detail: "Lead has no email address" });
    }
  }

  return results;
}

// ── Main run: slot = "morning" | "evening" ───────────────────────────────────
// Returns { matched, sent, details } — details is a per-lead breakdown of
// WhatsApp/Email results, useful for the temporary dev test route and for
// eyeballing exactly why a channel was sent/skipped/failed.
//
// opts.companyId — limit to one company. Without it, every company with the
// reminder enabled is processed (used by the dev test route). Timing per
// company (morning/evening time, interval days, on/off) comes from
// Customize CRM → Alerts → "Follow-up reminders to the lead".
async function runFollowUpReminderCheck(slot, opts = {}) {
  let companyIds;
  if (opts.companyId) {
    companyIds = [String(opts.companyId)];
  } else {
    const companies = await Company.find({ isActive: { $ne: false } }).select("_id").lean();
    companyIds = companies.map((c) => String(c._id));
  }
  const total = { matched: 0, sent: 0, details: [] };
  for (const companyId of companyIds) {
    const cust = await custSvc.getCustomization(companyId);
    const cfg = cust.alerts?.leadFollowUpReminder;
    if (!cfg || !cfg.enabled) continue;
    const r = await runFollowUpReminderForCompany(companyId, cust, slot);
    total.matched += r.matched || 0;
    total.sent += r.sent || 0;
    total.details.push(...(r.details || []));
  }
  return total;
}

async function runFollowUpReminderForCompany(companyId, cust, slot) {
  const clock    = custSvc.companyClock(cust);
  const todayKey = clock.dayKey;
  const todayEnd = new Date(custSvc.companyDateAt(cust, 1, 0, 0).getTime() - 1);
  const intervalDays = cust.alerts?.leadFollowUpReminder?.intervalDays || REMINDER_INTERVAL_DAYS;

  let leads;
  try {
    leads = await Lead.find({
      company:    companyId,
      isClosed:   { $ne: true },
      status:     { $nin: custSvc.closedStatusKeys(cust) },
      mergedInto: null,
      // Leads who tapped "Stop Promotion" are permanently excluded
      followUpReminderOptOut: { $ne: true },
      whatsappOptOut:         { $ne: true },
      scheduledCalls: {
        $elemMatch: { type: "follow-up", done: false, scheduledAt: { $lte: todayEnd } },
      },
      // Skip leads already reminded for THIS slot today
      $nor: [
        { followUpReminderLastSentDate: todayKey, followUpReminderLastSentSlot: slot },
      ],
    })
      .select("name mobile email company scheduledCalls followUpReminderLastSentDate followUpReminderLastSentSlot followUpReminderCycleStart")
      .lean();
  } catch (err) {
    console.error(`[followUpReminder:${slot}] query error (${companyId}):`, err.message);
    return { matched: 0, sent: 0, details: [], error: err.message };
  }

  if (!leads.length) return { matched: 0, sent: 0, details: [] };

  let company;
  try {
    // NOT using .lean(): Mongoose skips schema defaults on lean results.
    // Hydrating the doc + .toObject() applies the schema defaults even for
    // company docs that predate this field, so the reminder works with no
    // DB migration. (Templates are editable in Customize CRM → Automations.)
    const companyDoc = await Company.findById(companyId).select("followUpReminder name");
    company = companyDoc ? companyDoc.toObject() : null;
  } catch (err) {
    console.error(`[followUpReminder:${slot}] company lookup error (${companyId}):`, err.message);
    return { matched: leads.length, sent: 0, details: [] };
  }
  if (!company) return { matched: leads.length, sent: 0, details: [] };

  const details = [];
  // If BOTH channels are off for this company, skip cheaply
  const waOn = !!company.followUpReminder?.whatsapp?.enabled;
  const emOn = !!company.followUpReminder?.email?.enabled;
  if (!waOn && !emOn) {
    details.push({
      leadId: String(leads[0]?._id || ""),
      company: company.name,
      results: [{ channel: "all", status: "skipped", detail: "followUpReminder disabled for this company (both channels off)" }],
    });
    return { matched: leads.length, sent: 0, details };
  }

  let sent = 0;
  for (const lead of leads) {
    // ── N-day cadence gate ──────────────────────────────────────────────────
    // Fire only when a new cycle is due. On the cycle-start day BOTH slots
    // fire; the lead is then skipped until intervalDays have elapsed.
    //   • never reminded            → eligible, start a cycle
    //   • same day as cycle start   → eligible (this is the day's 2nd slot)
    //   • >= interval days elapsed  → eligible, start a NEW cycle
    //   • 1..interval-1 days        → skip (inside the quiet window)
    const cycleStart   = lead.followUpReminderCycleStart || null;
    const daysElapsed  = dayDiffKeys(cycleStart, todayKey); // Infinity if never
    const startNewCycle = !cycleStart || daysElapsed >= intervalDays;
    const sameCycleDay  = daysElapsed === 0;
    if (!startNewCycle && !sameCycleDay) {
      continue; // inside the quiet window — no reminder today
    }

    const results = await fireFollowUpReminder(lead, company);
    console.log(
      `[followUpReminder:${slot}] lead ${lead._id} ("${lead.name}"):`,
      JSON.stringify(results)
    );
    details.push({ leadId: String(lead._id), leadName: lead.name, company: company.name, results });
    try {
      const update = { followUpReminderLastSentDate: todayKey, followUpReminderLastSentSlot: slot };
      // Only stamp a new cycle start when a fresh cycle actually begins, so
      // the evening slot on the same day doesn't reset the clock.
      if (startNewCycle) update.followUpReminderCycleStart = todayKey;
      await Lead.updateOne({ _id: lead._id }, { $set: update });
    } catch (err) {
      console.error(`[followUpReminder:${slot}] mark-sent error for lead ${lead._id}:`, err.message);
    }
    sent++;
  }

  if (sent) console.log(`[followUpReminder:${slot}] (${company.name}) Sent ${sent} reminder(s).`);
  return { matched: leads.length, sent, details };
}

// Once-per-company-per-slot-per-day guard (Redis when available).
const _slotRan = new Map();
async function claimSlot(companyId, dayKey, slot) {
  const k = `fur:${companyId}:${dayKey}:${slot}`;
  if (_slotRan.get(k)) return false;
  try {
    const { redisClient } = require("../middlewares/rateLimiter");
    if (redisClient && redisClient.isReady) {
      const ok = await redisClient.set(`job:${k}`, "1", { NX: true, EX: 2 * 24 * 3600 });
      if (ok !== "OK") { _slotRan.set(k, true); return false; }
    }
  } catch (_) { /* in-process guard only */ }
  _slotRan.set(k, true);
  if (_slotRan.size > 20000) _slotRan.clear();
  return true;
}

// Every 15 minutes: for each company, fire the morning / evening slot once the
// company's configured time has passed (company timezone).
async function followUpReminderTick() {
  try {
    const companies = await Company.find({ isActive: { $ne: false } }).select("_id").lean();
    const custMap = await custSvc.getCustomizationMany(companies.map((c) => c._id));
    for (const c of companies) {
      const id = String(c._id);
      const cust = custMap.get(id);
      const cfg = cust?.alerts?.leadFollowUpReminder;
      if (!cfg || !cfg.enabled) continue;
      const clock = custSvc.companyClock(cust);
      const slots = [["morning", cfg.morningTime]];
      if (cfg.eveningEnabled) slots.push(["evening", cfg.eveningTime]);
      for (const [slot, time] of slots) {
        if (clock.minutesOfDay < custSvc.hhmmToMinutes(time, slot === "morning" ? 570 : 1230)) continue;
        if (!(await claimSlot(id, clock.dayKey, slot))) continue;
        await runFollowUpReminderForCompany(id, cust, slot).catch((e) =>
          console.error(`[followUpReminder:${slot}] job error (${id}):`, e.message)
        );
      }
    }
  } catch (err) {
    console.error("[followUpReminder] tick error:", err.message);
  }
}

function startFollowUpReminderJob() {
  cron.schedule("*/15 * * * *", () => { followUpReminderTick(); });
  console.log("✅ Follow-up reminder job started (WhatsApp + Email to lead — per-company times & cadence, checked every 15 min).");
}

module.exports = { startFollowUpReminderJob, runFollowUpReminderCheck, followUpReminderTick };
