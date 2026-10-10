// controllers/financeController.js — NEW FILE
// Finance Dashboard API. Three kinds of caller share these handlers:
//   • admin / super_admin  (protectAdmin)      → full access to their company
//   • developer            (protectDeveloper)  → same, for /developer/companies/:companyId/finance
//   • employee             (protect)           → only invoices assigned to them,
//                                                and only follow-up date + remarks
"use strict";

const mongoose       = require("mongoose");
const FinanceInvoice = require("../models/FinanceInvoice");
const FinanceSettings = require("../models/FinanceSettings");
const User           = require("../models/Users");
const { istDayKey }  = require("../utils/istDate");
const fin            = require("../services/financeService");

// ── helpers ──────────────────────────────────────────────────────────────────
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const num  = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const esc  = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function companyIdOf(req) {
  // Only a developer may pick the company via the URL. Everyone else is pinned
  // to the company on their own token — otherwise an admin/employee could reach
  // another tenant through /developer/companies/:companyId/finance.
  if (req.developer) return isId(req.params?.companyId) ? String(req.params.companyId) : null;
  const c =
    req.admin?.company?._id || req.admin?.company ||
    req.user?.companyId || req.user?.company?._id || req.user?.company ||
    null;
  return c ? String(c) : null;
}

function actorOf(req) {
  if (req.developer) return { id: req.developer._id, name: req.developer.name || "Developer", role: "developer" };
  if (req.admin)     return { id: req.admin._id,     name: req.admin.name || "Admin",         role: req.admin.role || "admin" };
  return { id: req.user?._id || req.user?.id || null, name: req.user?.name || "Employee", role: "employee" };
}

const fail = (res, code, message, extra = {}) => res.status(code).json({ success: false, message, ...extra });

function sendDup(res, e, fallback) {
  if (e && e.code === 11000) return fail(res, 409, "That invoice number is already used. Choose a different one.");
  console.error("[finance]", fallback, e && e.message);
  return fail(res, 500, fallback);
}

async function loadInvoice(req, res) {
  if (!isId(req.params.id)) { fail(res, 400, "Invalid invoice id"); return null; }
  const cid = companyIdOf(req);
  if (!cid) { fail(res, 400, "Company context not found"); return null; }
  const inv = await FinanceInvoice.findOne({ _id: req.params.id, company: cid });
  if (!inv) { fail(res, 404, "Invoice not found"); return null; }
  return inv;
}

async function resolveAssignee(cid, assignedTo) {
  if (!assignedTo) return { assignedTo: null, assignedToName: "" };
  if (!isId(assignedTo)) return { error: "Invalid employee" };
  const u = await User.findOne({ _id: assignedTo, company: cid }).select("name").lean();
  if (!u) return { error: "Employee not found in your company" };
  return { assignedTo: u._id, assignedToName: u.name || "" };
}

function parseFollowUp(value) {
  if (value === null || value === "" ) return { date: null };
  const d = fin.parseDay(value);
  if (!d) return { error: "Invalid follow-up date" };
  return { date: d };
}

function pushRemark(inv, actor, text, kind = "remark") {
  inv.remarks.push({ text, kind, by: actor.id, byName: actor.name, byRole: actor.role, at: new Date() });
}

const fmtDay = (d) => (d ? istDayKey(d) : "none");

// ── Settings ─────────────────────────────────────────────────────────────────
exports.getSettings = async (req, res) => {
  try {
    const cid = companyIdOf(req);
    if (!cid) return fail(res, 400, "Company context not found");
    const s = await fin.getSettings(cid);
    res.json({ success: true, settings: { invoicePrefix: s.invoicePrefix } });
  } catch (e) { fail(res, 500, "Could not load settings"); }
};

exports.updateSettings = async (req, res) => {
  try {
    const cid = companyIdOf(req);
    if (!cid) return fail(res, 400, "Company context not found");
    const prefix = fin.cleanPrefix(req.body?.invoicePrefix);
    const s = await FinanceSettings.findOneAndUpdate(
      { company: cid },
      { $set: { invoicePrefix: prefix } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({ success: true, settings: { invoicePrefix: s.invoicePrefix } });
  } catch (e) { fail(res, 500, "Could not save settings"); }
};

// ── Employees for the "assign follow-up to" dropdown ─────────────────────────
exports.listAssignees = async (req, res) => {
  try {
    const cid = companyIdOf(req);
    if (!cid) return fail(res, 400, "Company context not found");
    const users = await User.find({ company: cid }).select("name role").sort({ name: 1 }).lean();
    res.json({ success: true, assignees: users.map((u) => ({ _id: u._id, name: u.name, role: u.role })) });
  } catch (e) { fail(res, 500, "Could not load employees"); }
};

// ── List + summary ───────────────────────────────────────────────────────────
function buildFilter(cid, q) {
  const f = { company: new mongoose.Types.ObjectId(cid) };
  const today = fin.todayKey();
  const status = q.status || "all";

  if (status === "cancelled") f.status = "cancelled";
  else f.status = "active";

  if (status === "unpaid" || status === "partial" || status === "paid") f.paymentStatus = status;
  if (status === "pending") f.paymentStatus = { $in: ["unpaid", "partial"] };
  if (status === "overdue") {
    f.paymentStatus = { $ne: "paid" };
    f.nextFollowUpDate = { $ne: null, $lt: fin.parseDay(today) };
  }
  if (status === "due_today") {
    f.paymentStatus = { $ne: "paid" };
    f.nextFollowUpDate = { $gte: fin.parseDay(today), $lte: fin.endOfDay(today) };
  }

  if (q.source === "lead" || q.source === "manual") f.source = q.source;
  if (q.assignedTo && isId(q.assignedTo)) f.assignedTo = new mongoose.Types.ObjectId(q.assignedTo);
  if (q.assignedTo === "none") f.assignedTo = null;

  const from = q.from ? fin.parseDay(q.from) : null;
  const to   = q.to   ? fin.parseDay(q.to)   : null;
  if (from || to) {
    f.conversionDate = {};
    if (from) f.conversionDate.$gte = from;
    if (to)   f.conversionDate.$lte = fin.endOfDay(istDayKey(to));
  }

  const ffrom = q.followFrom ? fin.parseDay(q.followFrom) : null;
  const fto   = q.followTo   ? fin.parseDay(q.followTo)   : null;
  if (ffrom || fto) {
    const r = f.nextFollowUpDate && typeof f.nextFollowUpDate === "object" ? f.nextFollowUpDate : {};
    if (ffrom) r.$gte = ffrom;
    if (fto)   r.$lte = fin.endOfDay(istDayKey(fto));
    f.nextFollowUpDate = r;
  }

  const term = String(q.q || "").trim().slice(0, 80);
  if (term) {
    const rx = new RegExp(esc(term), "i");
    f.$or = [{ invoiceNumber: rx }, { customerName: rx }, { businessName: rx }, { assignedToName: rx }];
  }
  return f;
}

async function computeSummary(cid) {
  const today = fin.todayKey();
  const startToday = fin.parseDay(today);
  const endToday   = fin.endOfDay(today);
  const base = { company: new mongoose.Types.ObjectId(cid), status: "active" };
  const [agg] = await FinanceInvoice.aggregate([
    { $match: base },
    { $group: {
        _id: null,
        count:     { $sum: 1 },
        invoiced:  { $sum: "$totalAmount" },
        collected: { $sum: "$paidAmount" },
        outstanding: { $sum: "$balance" },
        paid:    { $sum: { $cond: [{ $eq: ["$paymentStatus", "paid"] }, 1, 0] } },
        partial: { $sum: { $cond: [{ $eq: ["$paymentStatus", "partial"] }, 1, 0] } },
        unpaid:  { $sum: { $cond: [{ $eq: ["$paymentStatus", "unpaid"] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $and: [
          { $ne: ["$paymentStatus", "paid"] },
          { $ne: ["$nextFollowUpDate", null] },
          { $lt: ["$nextFollowUpDate", startToday] },
        ] }, 1, 0] } },
        dueToday: { $sum: { $cond: [{ $and: [
          { $ne: ["$paymentStatus", "paid"] },
          { $gte: ["$nextFollowUpDate", startToday] },
          { $lte: ["$nextFollowUpDate", endToday] },
        ] }, 1, 0] } },
        needsAmount: { $sum: { $cond: [{ $eq: ["$totalAmount", 0] }, 1, 0] } },
    } },
  ]);
  const cancelled = await FinanceInvoice.countDocuments({ company: base.company, status: "cancelled" });
  const r = agg || {};
  return {
    count: r.count || 0, invoiced: r.invoiced || 0, collected: r.collected || 0, outstanding: r.outstanding || 0,
    paid: r.paid || 0, partial: r.partial || 0, unpaid: r.unpaid || 0,
    overdue: r.overdue || 0, dueToday: r.dueToday || 0, needsAmount: r.needsAmount || 0, cancelled,
  };
}

exports.listInvoices = async (req, res) => {
  try {
    const cid = companyIdOf(req);
    if (!cid) return fail(res, 400, "Company context not found");

    // Pull any newly converted leads in before listing
    await fin.syncConvertedLeads(cid);

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const sortMap = {
      conversion_desc: { conversionDate: -1, _id: -1 },
      conversion_asc:  { conversionDate: 1, _id: 1 },
      followup_asc:    { nextFollowUpDate: 1, _id: 1 },
      balance_desc:    { balance: -1, _id: -1 },
      amount_desc:     { totalAmount: -1, _id: -1 },
    };
    const sort = sortMap[req.query.sort] || sortMap.conversion_desc;
    const filter = buildFilter(cid, req.query);

    const [total, rows, summary] = await Promise.all([
      FinanceInvoice.countDocuments(filter),
      FinanceInvoice.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      computeSummary(cid),
    ]);
    const now = new Date();
    res.json({
      success: true,
      invoices: rows.map((r) => fin.toDTO(r, now)),
      total, page, pages: Math.max(1, Math.ceil(total / limit)), summary,
    });
  } catch (e) {
    console.error("[finance] list:", e.message);
    fail(res, 500, "Could not load invoices");
  }
};

exports.getInvoice = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    res.json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { fail(res, 500, "Could not load invoice"); }
};

// ── Create (manual) ──────────────────────────────────────────────────────────
exports.createInvoice = async (req, res) => {
  try {
    const cid = companyIdOf(req);
    if (!cid) return fail(res, 400, "Company context not found");
    const b = req.body || {};
    const actor = actorOf(req);

    const customerName = String(b.customerName || "").trim();
    if (!customerName) return fail(res, 400, "Customer name is required");

    const total = num(b.totalAmount);
    if (!(total > 0)) return fail(res, 400, "Total amount must be greater than 0");

    const planned = b.installmentsPlanned === undefined || b.installmentsPlanned === "" || b.installmentsPlanned === null
      ? null : Math.floor(Number(b.installmentsPlanned));
    if (planned !== null && !(planned >= 1 && planned <= 120)) return fail(res, 400, "Number of installments must be between 1 and 120");

    const assignee = await resolveAssignee(cid, b.assignedTo);
    if (assignee.error) return fail(res, 400, assignee.error);

    const fu = parseFollowUp(b.nextFollowUpDate === undefined ? null : b.nextFollowUpDate);
    if (fu.error) return fail(res, 400, fu.error);

    const conversionDate = b.conversionDate ? fin.parseDay(b.conversionDate) : fin.parseDay(new Date());
    if (!conversionDate) return fail(res, 400, "Invalid conversion date");

    let invoiceNumber = String(b.invoiceNumber || "").trim();
    if (invoiceNumber.length > 40) return fail(res, 400, "Invoice number is too long");
    if (!invoiceNumber) {
      const s = await fin.getSettings(cid);
      invoiceNumber = await fin.nextInvoiceNumber(cid, s.invoicePrefix);
    }

    const inv = new FinanceInvoice({
      company: cid,
      source: "manual",
      invoiceNumber,
      customerName,
      businessName: String(b.businessName || "").trim(),
      service:      String(b.service || "").trim(),
      description:  String(b.description || "").trim(),
      assignedTo: assignee.assignedTo,
      assignedToName: assignee.assignedToName,
      assignedAdmin: req.admin && !req.admin.isSuperAdmin ? req.admin._id : null,
      createdBy: actor,
      conversionDate,
      totalAmount: total,
      installmentsPlanned: planned,
      nextFollowUpDate: fu.date,
    });

    // Optional first payment taken at creation
    const first = num(b.initialPayment && b.initialPayment.amount);
    if (first > 0) {
      if (first > total + 0.005) return fail(res, 400, "First payment is more than the total amount");
      inv.payments.push({
        amount: first,
        paidOn: (b.initialPayment.paidOn && fin.parseDay(b.initialPayment.paidOn)) || new Date(),
        method: String(b.initialPayment.method || "").trim(),
        reference: String(b.initialPayment.reference || "").trim(),
        recordedBy: actor.id, recordedByName: actor.name,
      });
    }

    const remark = String(b.remark || "").trim();
    if (remark) pushRemark(inv, actor, remark);
    pushRemark(inv, actor, "Invoice created manually.", "system");

    inv.recalc();
    await inv.save();
    res.status(201).json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { sendDup(res, e, "Could not create invoice"); }
};

// ── Edit core details ────────────────────────────────────────────────────────
exports.updateInvoice = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    const cid = String(inv.company);
    const b = req.body || {};
    const actor = actorOf(req);
    const changes = [];

    if (b.customerName !== undefined) {
      const v = String(b.customerName).trim();
      if (!v) return fail(res, 400, "Customer name cannot be empty");
      inv.customerName = v;
    }
    if (b.businessName !== undefined) inv.businessName = String(b.businessName).trim();
    if (b.service      !== undefined) inv.service      = String(b.service).trim();
    if (b.description  !== undefined) inv.description  = String(b.description).trim();

    if (b.invoiceNumber !== undefined) {
      const v = String(b.invoiceNumber).trim();
      if (!v) return fail(res, 400, "Invoice number cannot be empty");
      if (v.length > 40) return fail(res, 400, "Invoice number is too long");
      if (v !== inv.invoiceNumber) { changes.push(`invoice number ${inv.invoiceNumber} → ${v}`); inv.invoiceNumber = v; }
    }

    if (b.totalAmount !== undefined) {
      const t = num(b.totalAmount);
      if (!(t >= 0)) return fail(res, 400, "Total amount must be a valid number");
      if (t + 0.005 < inv.paidAmount) return fail(res, 400, `Total can't be lower than what's already paid (₹${inv.paidAmount}).`);
      if (t !== inv.totalAmount) { changes.push(`total amount ₹${inv.totalAmount} → ₹${t}`); inv.totalAmount = t; }
    }

    if (b.installmentsPlanned !== undefined) {
      if (b.installmentsPlanned === null || b.installmentsPlanned === "") inv.installmentsPlanned = null;
      else {
        const n = Math.floor(Number(b.installmentsPlanned));
        if (!(n >= 1 && n <= 120)) return fail(res, 400, "Number of installments must be between 1 and 120");
        inv.installmentsPlanned = n;
      }
    }

    if (b.conversionDate !== undefined) {
      const d = fin.parseDay(b.conversionDate);
      if (!d) return fail(res, 400, "Invalid conversion date");
      inv.conversionDate = d;
    }

    if (b.assignedTo !== undefined) {
      const a = await resolveAssignee(cid, b.assignedTo || null);
      if (a.error) return fail(res, 400, a.error);
      if (String(a.assignedTo || "") !== String(inv.assignedTo || "")) {
        changes.push(`follow-up owner → ${a.assignedToName || "unassigned"}`);
        inv.assignedTo = a.assignedTo;
        inv.assignedToName = a.assignedToName;
        inv.followUpReminderDay = null; // new owner should get today's reminder
      }
    }

    if (changes.length) pushRemark(inv, actor, `Updated: ${changes.join("; ")}.`, "system");
    inv.recalc();
    await inv.save();
    res.json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { sendDup(res, e, "Could not update invoice"); }
};

// ── Payments (parts) ─────────────────────────────────────────────────────────
exports.addPayment = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    if (inv.status === "cancelled") return fail(res, 400, "This invoice is cancelled.");
    if (!(inv.totalAmount > 0)) return fail(res, 400, "Set the invoice's total amount before recording a payment.");

    const b = req.body || {};
    const amount = Math.round(num(b.amount) * 100) / 100;
    if (!(amount > 0)) return fail(res, 400, "Enter a payment amount greater than 0");
    if (amount > inv.balance + 0.005) return fail(res, 400, `Amount is more than the balance due (₹${inv.balance}).`);

    const paidOn = b.paidOn ? fin.parseDay(b.paidOn) : new Date();
    if (!paidOn) return fail(res, 400, "Invalid payment date");

    const actor = actorOf(req);
    inv.payments.push({
      amount, paidOn,
      method: String(b.method || "").trim(),
      reference: String(b.reference || "").trim(),
      note: String(b.note || "").trim(),
      recordedBy: actor.id, recordedByName: actor.name,
    });
    inv.recalc();
    pushRemark(inv, actor,
      `Payment of ₹${amount} received (part ${inv.payments.length}${inv.installmentsPlanned ? ` of ${inv.installmentsPlanned}` : ""}). ` +
      (inv.paymentStatus === "paid" ? "Invoice fully paid." : `Balance ₹${inv.balance}.`), "system");

    // Optional: schedule the next chase in the same step
    if (b.nextFollowUpDate !== undefined && inv.paymentStatus !== "paid") {
      const fu = parseFollowUp(b.nextFollowUpDate);
      if (fu.error) return fail(res, 400, fu.error);
      if (fmtDay(fu.date) !== fmtDay(inv.nextFollowUpDate)) { inv.nextFollowUpDate = fu.date; inv.followUpReminderDay = null; }
    }
    await inv.save();
    res.status(201).json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { fail(res, 500, "Could not record payment"); }
};

exports.updatePayment = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    const p = inv.payments.id(req.params.paymentId);
    if (!p) return fail(res, 404, "Payment not found");
    const b = req.body || {};
    const actor = actorOf(req);

    if (b.amount !== undefined) {
      const amount = Math.round(num(b.amount) * 100) / 100;
      if (!(amount > 0)) return fail(res, 400, "Enter a payment amount greater than 0");
      const others = inv.paidAmount - p.amount;
      if (others + amount > inv.totalAmount + 0.005) return fail(res, 400, "That would make total paid more than the invoice total.");
      p.amount = amount;
    }
    if (b.paidOn !== undefined) { const d = fin.parseDay(b.paidOn); if (!d) return fail(res, 400, "Invalid payment date"); p.paidOn = d; }
    if (b.method !== undefined)    p.method = String(b.method).trim();
    if (b.reference !== undefined) p.reference = String(b.reference).trim();
    if (b.note !== undefined)      p.note = String(b.note).trim();

    inv.recalc();
    pushRemark(inv, actor, `A payment entry was edited (now ₹${p.amount}).`, "system");
    await inv.save();
    res.json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { fail(res, 500, "Could not update payment"); }
};

exports.deletePayment = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    const p = inv.payments.id(req.params.paymentId);
    if (!p) return fail(res, 404, "Payment not found");
    const amt = p.amount;
    p.deleteOne();
    inv.recalc();
    pushRemark(inv, actorOf(req), `A payment entry of ₹${amt} was removed.`, "system");
    await inv.save();
    res.json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { fail(res, 500, "Could not remove payment"); }
};

// ── Follow-up date + remarks (admins AND the assigned employee) ──────────────
async function applyFollowUp(inv, req, res) {
  const b = req.body || {};
  const actor = actorOf(req);
  if (inv.status === "cancelled") { fail(res, 400, "This invoice is cancelled."); return null; }
  if (inv.paymentStatus === "paid") { fail(res, 400, "This invoice is fully paid — no follow-up needed."); return null; }

  const fu = parseFollowUp(b.nextFollowUpDate === undefined ? null : b.nextFollowUpDate);
  if (fu.error) { fail(res, 400, fu.error); return null; }

  const before = fmtDay(inv.nextFollowUpDate);
  const after  = fmtDay(fu.date);
  inv.nextFollowUpDate = fu.date;
  if (before !== after) inv.followUpReminderDay = null; // re-arm the reminder for the new date

  const note = String(b.remark || "").trim();
  if (before !== after || note) {
    const head = fu.date ? `Follow-up ${before === "none" ? "set" : "moved"} to ${after}` : "Follow-up date cleared";
    pushRemark(inv, actor, note ? `${head} — ${note}` : head, "followup");
  }
  await inv.save();
  return inv;
}

exports.setFollowUp = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    const out = await applyFollowUp(inv, req, res); if (!out) return;
    res.json({ success: true, invoice: fin.toDTO(out) });
  } catch (e) { fail(res, 500, "Could not save follow-up"); }
};

exports.addRemark = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return fail(res, 400, "Write a remark first");
    if (text.length > 1000) return fail(res, 400, "Remark is too long (max 1000 characters)");
    pushRemark(inv, actorOf(req), text);
    await inv.save();
    res.status(201).json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { fail(res, 500, "Could not save remark"); }
};

// ── Cancel / reopen ──────────────────────────────────────────────────────────
exports.cancelInvoice = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    if (inv.status === "cancelled") return fail(res, 400, "Already cancelled");
    inv.status = "cancelled";
    inv.cancelledAt = new Date();
    inv.cancelReason = String((req.body && req.body.reason) || "").trim();
    inv.nextFollowUpDate = null;
    pushRemark(inv, actorOf(req), `Invoice cancelled${inv.cancelReason ? `: ${inv.cancelReason}` : "."}`, "system");
    await inv.save();
    res.json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { fail(res, 500, "Could not cancel invoice"); }
};

exports.reopenInvoice = async (req, res) => {
  try {
    const inv = await loadInvoice(req, res); if (!inv) return;
    if (inv.status !== "cancelled") return fail(res, 400, "Invoice is not cancelled");
    inv.status = "active"; inv.cancelledAt = null; inv.cancelReason = "";
    pushRemark(inv, actorOf(req), "Invoice reopened.", "system");
    await inv.save();
    res.json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { fail(res, 500, "Could not reopen invoice"); }
};

// ── Employee endpoints (/my/*) ───────────────────────────────────────────────
exports.myFollowUps = async (req, res) => {
  try {
    const cid = companyIdOf(req);
    const uid = req.user && (req.user._id || req.user.id);
    if (!cid || !uid) return fail(res, 400, "Company context not found");
    const filter = {
      company: new mongoose.Types.ObjectId(cid),
      assignedTo: new mongoose.Types.ObjectId(String(uid)),
      status: "active",
      paymentStatus: { $ne: "paid" },
    };
    const rows = await FinanceInvoice.find(filter)
      .sort({ nextFollowUpDate: 1, conversionDate: -1 }).limit(300).lean();
    const now = new Date();
    const list = rows.map((r) => fin.toDTO(r, now));
    res.json({
      success: true,
      invoices: list,
      counts: {
        overdue:  list.filter((i) => i.isOverdue).length,
        dueToday: list.filter((i) => i.isDueToday).length,
        total:    list.length,
      },
    });
  } catch (e) { fail(res, 500, "Could not load your follow-ups"); }
};

// Employee may only touch invoices assigned to them
async function loadMine(req, res) {
  const inv = await loadInvoice(req, res); if (!inv) return null;
  const uid = String((req.user && (req.user._id || req.user.id)) || "");
  if (!inv.assignedTo || String(inv.assignedTo) !== uid) { fail(res, 403, "This invoice is not assigned to you."); return null; }
  return inv;
}

exports.myFollowUp = async (req, res) => {
  try {
    const inv = await loadMine(req, res); if (!inv) return;
    const out = await applyFollowUp(inv, req, res); if (!out) return;
    res.json({ success: true, invoice: fin.toDTO(out) });
  } catch (e) { fail(res, 500, "Could not save follow-up"); }
};

exports.myRemark = async (req, res) => {
  try {
    const inv = await loadMine(req, res); if (!inv) return;
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return fail(res, 400, "Write a remark first");
    if (text.length > 1000) return fail(res, 400, "Remark is too long (max 1000 characters)");
    pushRemark(inv, actorOf(req), text);
    await inv.save();
    res.status(201).json({ success: true, invoice: fin.toDTO(inv) });
  } catch (e) { fail(res, 500, "Could not save remark"); }
};
