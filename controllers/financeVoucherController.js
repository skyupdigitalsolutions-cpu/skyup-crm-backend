// controllers/financeVoucherController.js — Finance dashboard → Payment vouchers.
// Same company scoping / actor attribution as financeHrController. Totals, TDS,
// payable amount and amount-in-words are always computed here, never trusted
// from the browser, so a printed voucher can't carry arithmetic mistakes.
"use strict";
const mongoose = require("mongoose");
const FinanceVoucher = require("../models/FinanceVoucher");
const Counter = require("../models/Counter");
const { amountInWords } = require("../utils/amountInWords");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
function companyIdOf(req) {
  if (req.developer) return isId(req.params?.companyId) ? String(req.params.companyId) : null;
  const c = req.admin?.company?._id || req.admin?.company || req.user?.companyId || req.user?.company?._id || req.user?.company || null;
  return c ? String(c) : null;
}
function actorOf(req) {
  if (req.developer) return { id: req.developer._id, name: req.developer.name || "Developer" };
  if (req.admin) return { id: req.admin._id, name: req.admin.name || "Admin" };
  return { id: req.user?._id || req.user?.id || null, name: req.user?.name || "Finance" };
}
const fail = (res, code, message) => res.status(code).json({ success: false, message });
const r2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const str = (v, max) => String(v ?? "").trim().slice(0, max);

// Indian financial year (April–March) of a date, in IST: "2026-27".
function fyOf(date) {
  const ist = new Date(new Date(date).getTime() + 330 * 60000);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth();   // 0 = Jan
  const start = m >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// Body → clean voucher fields + computed money.
function voucherFrom(b) {
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 30)
    .map((l) => {
      const d = l?.date ? new Date(l.date) : null;
      return { date: d && !isNaN(d) ? d : null, details: str(l?.details, 300), amount: r2(Math.max(0, Number(l?.amount) || 0)) };
    })
    .filter((l) => l.details || l.amount);
  const total = r2(lines.reduce((a, l) => a + l.amount, 0));
  const tdsPercent = Math.min(100, Math.max(0, Number(b.tdsPercent) || 0));
  const tdsAmount = r2(total * tdsPercent / 100);
  const payableTotal = r2(total - tdsAmount);
  const date = b.voucherDate ? new Date(b.voucherDate) : new Date();
  return {
    voucherDate: isNaN(date) ? new Date() : date,
    debitAccountHead: str(b.debitAccountHead, 120),
    paidTo: str(b.paidTo, 120),
    lines, total, tdsPercent, tdsAmount, payableTotal,
    amountInWords: amountInWords(payableTotal),
    paymentMode: ["cash", "cheque", "online"].includes(b.paymentMode) ? b.paymentMode : "cash",
    paymentRef: str(b.paymentRef, 120),
  };
}
function validate(v) {
  if (!v.debitAccountHead) return "Enter the debit account head.";
  if (!v.lines.length) return "Add at least one expense line.";
  if (v.lines.some((l) => !l.details)) return "Every line with an amount needs its details.";
  if (!(v.total > 0)) return "The total must be more than zero.";
  if (v.paymentMode !== "cash" && !v.paymentRef) return v.paymentMode === "cheque" ? "Enter the cheque number." : "Enter the online payment reference (UTR / UPI ref).";
  return "";
}

async function listVouchers(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const q = { company };
    if (req.query.from || req.query.to) {
      q.voucherDate = {};
      if (req.query.from) q.voucherDate.$gte = new Date(req.query.from);
      if (req.query.to) { const t = new Date(req.query.to); t.setHours(23, 59, 59, 999); q.voucherDate.$lte = t; }
    }
    if (req.query.head) q.debitAccountHead = req.query.head;
    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i");
      q.$or = [{ voucherNo: rx }, { debitAccountHead: rx }, { paidTo: rx }, { "lines.details": rx }, { paymentRef: rx }];
    }
    const vouchers = await FinanceVoucher.find(q).sort({ voucherDate: -1, seq: -1 }).limit(500).lean();
    const heads = await FinanceVoucher.distinct("debitAccountHead", { company });
    const activeTotal = r2(vouchers.filter((v) => v.status === "active").reduce((a, v) => a + v.payableTotal, 0));
    res.json({ success: true, vouchers, heads, summary: { count: vouchers.length, payable: activeTotal } });
  } catch (e) { fail(res, 500, "Could not load vouchers."); }
}

async function getVoucher(req, res) {
  try {
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid voucher.");
    const v = await FinanceVoucher.findOne({ _id: req.params.id, company }).lean();
    if (!v) return fail(res, 404, "Voucher not found.");
    res.json({ success: true, voucher: v });
  } catch (e) { fail(res, 500, "Could not load the voucher."); }
}

async function createVoucher(req, res) {
  try {
    const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
    const v = voucherFrom(req.body || {});
    const msg = validate(v); if (msg) return fail(res, 400, msg);
    const fy = fyOf(v.voucherDate);
    const c = await Counter.findOneAndUpdate({ _id: `voucher:${company}:${fy}` }, { $inc: { seq: 1 } }, { new: true, upsert: true });
    const a = actorOf(req);
    const voucher = await FinanceVoucher.create({
      company, ...v, fy, seq: c.seq, voucherNo: `PV/${fy}/${String(c.seq).padStart(4, "0")}`,
      createdBy: isId(a.id) ? a.id : null, createdByName: a.name,
    });
    res.json({ success: true, voucher: voucher.toObject() });
  } catch (e) {
    if (e && e.code === 11000) return fail(res, 409, "Voucher number clash — please try again.");
    fail(res, 500, "Could not save the voucher.");
  }
}

async function updateVoucher(req, res) {
  try {
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid voucher.");
    const existing = await FinanceVoucher.findOne({ _id: req.params.id, company });
    if (!existing) return fail(res, 404, "Voucher not found.");
    if (existing.status === "cancelled") return fail(res, 409, "A cancelled voucher can't be edited.");
    const v = voucherFrom(req.body || {});
    const msg = validate(v); if (msg) return fail(res, 400, msg);
    // The number belongs to its financial year: keep the date inside it.
    if (fyOf(v.voucherDate) !== existing.fy) return fail(res, 400, `Keep the date inside financial year ${existing.fy} (this voucher's number belongs to it).`);
    Object.assign(existing, v, { updatedByName: actorOf(req).name });
    await existing.save();
    res.json({ success: true, voucher: existing.toObject() });
  } catch (e) { fail(res, 500, "Could not update the voucher."); }
}

// Vouchers are never deleted: cancelling keeps the number in the register.
async function cancelVoucher(req, res) {
  try {
    const company = companyIdOf(req);
    if (!isId(req.params.id)) return fail(res, 400, "Invalid voucher.");
    const v = await FinanceVoucher.findOne({ _id: req.params.id, company });
    if (!v) return fail(res, 404, "Voucher not found.");
    v.status = "cancelled"; v.cancelReason = str(req.body?.reason, 300); v.updatedByName = actorOf(req).name;
    await v.save();
    res.json({ success: true, voucher: v.toObject() });
  } catch (e) { fail(res, 500, "Could not cancel the voucher."); }
}

module.exports = { listVouchers, getVoucher, createVoucher, updateVoucher, cancelVoucher, fyOf, voucherFrom };
