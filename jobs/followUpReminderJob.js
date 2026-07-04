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

const IST_TIMEZONE = "Asia/Kolkata";

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
async function runFollowUpReminderCheck(slot) {
  const now      = new Date();
  const todayKey = istDayKey(now);
  const todayEnd = istTodayEnd(now);

  let leads;
  try {
    leads = await Lead.find({
      isClosed:   { $ne: true },
      status:     { $ne: "Converted" },
      mergedInto: null,
      scheduledCalls: {
        $elemMatch: { type: "follow-up", done: false, scheduledAt: { $lte: todayEnd } },
      },
      // Skip leads already reminded for THIS slot today
      $nor: [
        { followUpReminderLastSentDate: todayKey, followUpReminderLastSentSlot: slot },
      ],
    })
      .select("name mobile email company scheduledCalls followUpReminderLastSentDate followUpReminderLastSentSlot")
      .lean();
  } catch (err) {
    console.error(`[followUpReminder:${slot}] query error:`, err.message);
    return { matched: 0, sent: 0, details: [], error: err.message };
  }

  if (!leads.length) {
    console.log(`[followUpReminder:${slot}] 0 lead(s) due.`);
    return { matched: 0, sent: 0, details: [] };
  }

  // Group by company so we fetch each company's settings once
  const byCompany = new Map();
  for (const lead of leads) {
    const cId = String(lead.company);
    if (!byCompany.has(cId)) byCompany.set(cId, []);
    byCompany.get(cId).push(lead);
  }

  let sent = 0;
  const details = [];
  for (const [companyId, companyLeads] of byCompany) {
    let company;
    try {
      // NOT using .lean(): Mongoose skips schema defaults on lean results, and
      // there's no admin UI that saves `followUpReminder` to the DB. Hydrating
      // the doc + .toObject() applies the schema defaults even for company docs
      // that predate this field, so the reminder works with no DB migration.
      const companyDoc = await Company.findById(companyId).select("followUpReminder name");
      company = companyDoc ? companyDoc.toObject() : null;
    } catch (err) {
      console.error(`[followUpReminder:${slot}] company lookup error (${companyId}):`, err.message);
      continue;
    }
    if (!company) continue;

    // If BOTH channels are off for this company, skip cheaply
    const waOn = !!company.followUpReminder?.whatsapp?.enabled;
    const emOn = !!company.followUpReminder?.email?.enabled;
    if (!waOn && !emOn) {
      details.push({
        leadId: String(companyLeads[0]?._id || ""),
        company: company.name,
        results: [{ channel: "all", status: "skipped", detail: "followUpReminder disabled for this company (both channels off)" }],
      });
      continue;
    }

    for (const lead of companyLeads) {
      const results = await fireFollowUpReminder(lead, company);
      console.log(
        `[followUpReminder:${slot}] lead ${lead._id} ("${lead.name}"):`,
        JSON.stringify(results)
      );
      details.push({ leadId: String(lead._id), leadName: lead.name, company: company.name, results });
      try {
        await Lead.updateOne(
          { _id: lead._id },
          { $set: { followUpReminderLastSentDate: todayKey, followUpReminderLastSentSlot: slot } }
        );
      } catch (err) {
        console.error(`[followUpReminder:${slot}] mark-sent error for lead ${lead._id}:`, err.message);
      }
      sent++;
    }
  }

  if (sent) console.log(`[followUpReminder:${slot}] Sent ${sent} reminder(s).`);
  return { matched: leads.length, sent, details };
}

function startFollowUpReminderJob() {
  // 9:30 AM IST
  cron.schedule(
    "30 9 * * *",
    () => {
      runFollowUpReminderCheck("morning").catch((e) =>
        console.error("[followUpReminder:morning] job error:", e.message)
      );
    },
    { timezone: IST_TIMEZONE }
  );

  // 8:30 PM IST
  cron.schedule(
    "30 20 * * *",
    () => {
      runFollowUpReminderCheck("evening").catch((e) =>
        console.error("[followUpReminder:evening] job error:", e.message)
      );
    },
    { timezone: IST_TIMEZONE }
  );

  console.log("✅ Follow-up reminder job started (WhatsApp + Email to lead, 9:30 AM & 8:30 PM IST).");
}

module.exports = { startFollowUpReminderJob, runFollowUpReminderCheck };