// jobs/financeFollowUpJob.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Finance Dashboard → payment follow-up reminders.
//
// Every 15 minutes, once it is past 9:30 AM IST, find invoices that
//   • are active and not fully paid
//   • have a follow-up date that is today or earlier (overdue)
//   • have not already been reminded today (followUpReminderDay, stored on the
//     invoice, so a restart or a second server never double-sends)
// and send ONE push per person summarising their invoices. The recipient is the
// employee the invoice is assigned to; if there is none, the lead's admin, then
// whoever created the invoice.
//
// Also converts any newly "won" leads into invoices for enabled companies, so
// the dashboard is already up to date when someone opens it.
//
// Overdue invoices keep reminding daily until the follow-up date is moved, the
// invoice is paid, or it is cancelled.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const cron = require("node-cron");
const Company        = require("../models/Company");
const User           = require("../models/Users");
const Admin          = require("../models/Admin");
const FinanceInvoice = require("../models/FinanceInvoice");
const fin            = require("../services/financeService");
const { sendPaymentFollowUpAlert } = require("../services/fcmService");

const REMINDER_HOUR_IST   = 9;
const REMINDER_MINUTE_IST = 30;

function istMinutesOfDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}

// Companies where the Developer switched the Finance Dashboard on.
async function enabledCompanyIds() {
  const rows = await Company.find({
    isActive: { $ne: false },
    "devOverrides.featureToggles.financeDashboard": true,
  }).select("_id").lean();
  return rows.map((r) => r._id);
}

async function runFinanceSync(companyIds) {
  for (const id of companyIds) await fin.syncConvertedLeads(id);
}

async function runFinanceFollowUpReminders() {
  try {
    const companyIds = await enabledCompanyIds();
    if (!companyIds.length) return;

    // Keep the dashboard fresh even if nobody has opened it
    await runFinanceSync(companyIds);

    const now = new Date();
    if (istMinutesOfDay(now) < REMINDER_HOUR_IST * 60 + REMINDER_MINUTE_IST) return;

    const today = fin.todayKey(now);
    const due = await FinanceInvoice.find({
      company: { $in: companyIds },
      status: "active",
      paymentStatus: { $ne: "paid" },
      nextFollowUpDate: { $ne: null, $lte: fin.endOfDay(today) },
      $or: [{ followUpReminderDay: null }, { followUpReminderDay: { $ne: today } }],
    })
      .select("company invoiceNumber customerName balance nextFollowUpDate assignedTo assignedAdmin createdBy")
      .lean();
    if (!due.length) return;

    // Group by who should be told
    const groups = new Map(); // "user:<id>" | "admin:<id>" → { kind, id, items[], invoiceIds[] }
    for (const inv of due) {
      let kind = null, id = null;
      if (inv.assignedTo) { kind = "user"; id = inv.assignedTo; }
      else if (inv.assignedAdmin) { kind = "admin"; id = inv.assignedAdmin; }
      else if (inv.createdBy && inv.createdBy.id && ["admin", "super_admin"].includes(inv.createdBy.role)) { kind = "admin"; id = inv.createdBy.id; }
      if (!kind) continue;

      const key = `${kind}:${id}`;
      if (!groups.has(key)) groups.set(key, { kind, id, items: [], invoiceIds: [] });
      const g = groups.get(key);
      g.items.push({
        invoiceId: inv._id,
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customerName,
        balance: inv.balance,
        overdue: fin.todayKey(inv.nextFollowUpDate) < today,
      });
      g.invoiceIds.push(inv._id);
    }
    if (!groups.size) return;

    const userIds  = [...groups.values()].filter((g) => g.kind === "user").map((g) => g.id);
    const adminIds = [...groups.values()].filter((g) => g.kind === "admin").map((g) => g.id);
    const [users, admins] = await Promise.all([
      userIds.length  ? User.find({ _id: { $in: userIds } }).select("name role fcmToken").lean()   : [],
      adminIds.length ? Admin.find({ _id: { $in: adminIds } }).select("name role fcmToken").lean() : [],
    ]);
    const people = new Map([
      ...users.map((u)  => [`user:${u._id}`,  u]),
      ...admins.map((a) => [`admin:${a._id}`, a]),
    ]);

    let sent = 0;
    for (const [key, g] of groups) {
      const person = people.get(key);
      if (!person) {
        // Owner no longer exists — mark so we don't re-scan them all day
        await FinanceInvoice.updateMany({ _id: { $in: g.invoiceIds } }, { $set: { followUpReminderDay: today } });
        continue;
      }
      // Overdue first, then biggest balance
      g.items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (b.balance || 0) - (a.balance || 0));
      const result = await sendPaymentFollowUpAlert(person, g.items);
      if (result === "error") continue; // transient — retry on the next 15-min tick
      if (result === "sent") sent++;
      await FinanceInvoice.updateMany({ _id: { $in: g.invoiceIds } }, { $set: { followUpReminderDay: today } });
    }
    if (sent) console.log(`[FinanceJob] payment follow-up reminders sent to ${sent} person(s) for ${due.length} invoice(s).`);
  } catch (err) {
    console.error("[FinanceJob] runFinanceFollowUpReminders error:", err.message);
  }
}

function startFinanceFollowUpJob() {
  cron.schedule("*/15 * * * *", () => { runFinanceFollowUpReminders(); });
  console.log("[FinanceJob] ✅ Finance follow-up reminders started (every 15 min; sends from 9:30 AM IST)");
}

module.exports = { startFinanceFollowUpJob, runFinanceFollowUpReminders };
