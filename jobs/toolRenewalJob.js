// jobs/toolRenewalJob.js — Finance Dashboard → subscription renewal reminders.
// Once a day (checked every 6 hours, fires after 9:30 AM IST) find tools/services whose renewal date is within their
// reminderDays window and not yet reminded today, and send ONE push to the company's finance recipients. Mirrors
// financeFollowUpJob's structure (enabled companies, IST gate, once-per-day guard stored on the row).
"use strict";
const cron = require("node-cron");
const Company     = require("../models/Company");
const Admin       = require("../models/Admin");
const FinanceTool = require("../models/FinanceTool");
const { sendToolRenewalAlert } = require("../services/fcmService");

const REMINDER_HOUR_IST = 9, REMINDER_MINUTE_IST = 30;

function istParts(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit", hour12: false }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t).value;
  return { minutes: (Number(g("hour")) % 24) * 60 + Number(g("minute")), day: `${g("year")}-${g("month")}-${g("day")}` };
}
async function enabledCompanyIds() {
  const rows = await Company.find({ isActive: { $ne: false }, "devOverrides.featureToggles.financeDashboard": true }).select("_id").lean();
  return rows.map((r) => r._id);
}

async function runToolRenewalReminders() {
  const { minutes, day } = istParts();
  if (minutes < REMINDER_HOUR_IST * 60 + REMINDER_MINUTE_IST) return;
  const companyIds = await enabledCompanyIds();
  if (!companyIds.length) return;
  const now = Date.now();
  for (const companyId of companyIds) {
    const tools = await FinanceTool.find({ company: companyId, active: { $ne: false }, renewalDate: { $ne: null } }).lean();
    const due = tools.filter((t) => {
      if (t.renewalReminderDay === day) return false;                       // already reminded today
      const days = Math.ceil((new Date(t.renewalDate).getTime() - now) / 86400000);
      return days <= (t.reminderDays ?? 7);                                 // within the reminder window (incl. overdue)
    });
    if (!due.length) continue;
    // recipients: finance-enabled admins of this company
    const recipients = await Admin.find({ company: companyId }).select("name role fcmToken _id").lean();
    const fmt = (d) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
    const items = due.map((t) => ({ id: String(t._id), name: t.name, when: fmt(t.renewalDate), cost: t.cost }));
    for (const r of recipients) {
      try { await sendToolRenewalAlert(r, items); } catch (e) { /* keep going */ }
    }
    // mark reminded today so a restart or second server never double-sends
    await FinanceTool.updateMany({ _id: { $in: due.map((t) => t._id) } }, { $set: { renewalReminderDay: day, lastReminderAt: new Date() } });
  }
}

function startToolRenewalJob() {
  // every 6 hours; the IST gate inside keeps it to one send/day
  cron.schedule("0 */6 * * *", () => { runToolRenewalReminders().catch((e) => console.error("[toolRenewalJob]", e && e.message)); });
  console.log("🔔 Tool renewal reminder job scheduled (every 6h, fires after 9:30 AM IST)");
}
module.exports = { startToolRenewalJob, runToolRenewalReminders };
