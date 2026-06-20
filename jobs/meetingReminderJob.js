// jobs/meetingReminderJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Sends the `client_meeting_reminder` WhatsApp template + a confirmation email
// to leads at THREE points around a scheduled meeting:
//
//   1. When the meeting is scheduled   → handled inline by meetingRemarkController
//                                         (marks reminders.scheduledAt).
//   2. The morning of the DAY BEFORE    → this job (reminders.dayBeforeAt).
//   3. The morning OF the meeting day   → this job (reminders.meetingDayAt),
//      before the meeting time (or ~2h before for early-morning meetings).
//
// Example: meeting on the 26th, scheduled on the 20th →
//   blast on 20th (scheduled), 25th morning (day-before), 26th morning (day-of).
//
// Times are computed in IST (Asia/Kolkata) since this is an India-first CRM.
// Override the morning hour with env MEETING_REMINDER_HOUR (default 8 = 8 AM IST).
//
// The job runs every 30 minutes. Each reminder is sent at most once (tracked by
// the per-meeting `reminders` timestamps), and never more than one reminder per
// meeting per calendar day.
// ─────────────────────────────────────────────────────────────────────────────

const cron = require("node-cron");
const Lead = require("../models/Leads");
const {
  _sendClientMeetingWhatsApp,
  _sendClientMeetingEmail,
} = require("../controllers/meetingRemarkController");

const IST_OFFSET_MIN = 330;                                   // +5:30
const MORNING_HOUR   = Number(process.env.MEETING_REMINDER_HOUR || 8);
const EARLY_LEAD_MS  = 2 * 60 * 60 * 1000;                    // 2h before for early meetings

// IST-local parts of a Date
function istParts(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  return {
    y: ist.getUTCFullYear(), m: ist.getUTCMonth(), d: ist.getUTCDate(),
    h: ist.getUTCHours(), min: ist.getUTCMinutes(),
  };
}
function istDayKey(date) { const p = istParts(date); return `${p.y}-${p.m}-${p.d}`; }

// Send the WhatsApp + email blast for one meeting entry. Non-throwing.
async function fireReminder(lead, entry, label) {
  const when = entry.followUpDate;
  const args = {
    lead,
    companyId:    lead.company,
    meetingDate:  when,
    meetingTime:  when,
    meetingMode:  entry.meetingType,
    agentName:    entry.userName || "Our Team",
    sentByUserId: entry.userId || null,
  };
  try {
    const wa = await _sendClientMeetingWhatsApp(args);
    console.log(`[meetingReminder:${label}] WA → lead ${lead._id}:`, wa.success ? `sent (${wa.waMessageId})` : `skipped (${wa.message})`);
  } catch (e) { console.error(`[meetingReminder:${label}] WA error:`, e.message); }
  try {
    const em = await _sendClientMeetingEmail(args);
    console.log(`[meetingReminder:${label}] Email → lead ${lead._id}:`, em.success ? `sent via ${em.provider}` : `skipped (${em.message})`);
  } catch (e) { console.error(`[meetingReminder:${label}] Email error:`, e.message); }
}

const runMeetingReminderCheck = async () => {
  const now    = new Date();
  const nowKey = istDayKey(now);
  // Look at meetings from a little in the past (grace) up to ~60 days ahead.
  const windowStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);

  const leads = await Lead.find({
    "meetingRemarks.followUpDate": { $gte: windowStart },
  }).select("name mobile email company meetingRemarks").lean();

  let sent = 0;

  for (const lead of leads) {
    for (const entry of lead.meetingRemarks || []) {
      const M = entry.followUpDate ? new Date(entry.followUpDate) : null;
      if (!M || isNaN(M.getTime())) continue;
      if (now >= M) continue;                       // meeting already started/passed

      const rem = entry.reminders || {};
      // Days already used for a reminder on this meeting — enforce max one/day.
      const usedDays = new Set(
        [rem.scheduledAt, rem.dayBeforeAt, rem.meetingDayAt]
          .filter(Boolean)
          .map((d) => istDayKey(new Date(d)))
      );
      if (usedDays.has(nowKey)) continue;            // already sent something today

      const meetingDayKey = istDayKey(M);
      const dayBeforeKey  = istDayKey(new Date(M.getTime() - 24 * 60 * 60 * 1000));
      const hourNow       = istParts(now).h;
      const pastMorning   = hourNow >= MORNING_HOUR;
      const within2h      = now >= new Date(M.getTime() - EARLY_LEAD_MS);

      let field = null, label = null;

      // Meeting-day reminder (morning of, before the meeting; or ~2h before if early)
      if (!rem.meetingDayAt && nowKey === meetingDayKey && (pastMorning || within2h)) {
        field = "meetingDayAt"; label = "day-of";
      }
      // Day-before reminder (morning of the day before)
      else if (!rem.dayBeforeAt && nowKey === dayBeforeKey && pastMorning) {
        field = "dayBeforeAt"; label = "day-before";
      }

      if (!field) continue;

      await fireReminder(lead, entry, label);
      try {
        await Lead.updateOne(
          { _id: lead._id, "meetingRemarks._id": entry._id },
          { $set: { [`meetingRemarks.$.reminders.${field}`]: new Date() } },
        );
      } catch (e) {
        console.error("[meetingReminder] mark sent error:", e.message);
      }
      sent++;
    }
  }

  if (sent) console.log(`[meetingReminder] Sent ${sent} reminder(s).`);
  return sent;
};

function startMeetingReminderJob() {
  // Every 30 minutes
  cron.schedule("*/30 * * * *", () => {
    runMeetingReminderCheck().catch((e) =>
      console.error("[meetingReminder] job error:", e.message)
    );
  });
  console.log(`✅ Meeting reminder job started (every 30 min, morning hour = ${MORNING_HOUR}:00 IST).`);
}

module.exports = { startMeetingReminderJob, runMeetingReminderCheck };