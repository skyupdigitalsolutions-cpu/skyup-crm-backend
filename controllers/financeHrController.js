// controllers/financeHrController.js — Finance dashboard: Employees, Salary slips, Tools & Services, Notes.
// Connected to the existing finance module: same company scoping (companyIdOf) and actor attribution (actorOf) as
// financeController, guarded by protectFinance on the routes. All data is per company.
"use strict";
const mongoose = require("mongoose");
const FinanceEmployee = require("../models/FinanceEmployee");
const SalaryRecord = require("../models/SalaryRecord");
const FinanceTool = require("../models/FinanceTool");
const FinanceNote = require("../models/FinanceNote");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
function companyIdOf(req) {
  if (req.developer) return isId(req.params?.companyId) ? String(req.params.companyId) : null;
  const c = req.admin?.company?._id || req.admin?.company || req.user?.companyId || req.user?.company?._id || req.user?.company || null;
  return c ? String(c) : null;
}
function actorOf(req) {
  if (req.developer) return { id: req.developer._id, name: req.developer.name || "Developer" };
  if (req.admin) return { id: req.admin._id, name: req.admin.name || "Admin" };
  return { id: req.user?._id || req.user?.id || null, name: req.user?.name || "Employee" };
}
const fail = (res, code, message) => res.status(code).json({ success: false, message });
const ok = (res, data) => res.json({ success: true, ...data });

// ── Employees ──────────────────────────────────────────────────────────────────
async function listEmployees(req, res) {
  const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
  const q = { company };
  if (req.query.active === "true") q.active = true;
  const items = await FinanceEmployee.find(q).sort({ name: 1 }).lean();
  ok(res, { employees: items });
}
async function getEmployee(req, res) {
  const company = companyIdOf(req); const e = await FinanceEmployee.findOne({ _id: req.params.id, company }).lean();
  if (!e) return fail(res, 404, "Employee not found."); ok(res, { employee: e });
}
async function createEmployee(req, res) {
  const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
  const a = actorOf(req); const b = req.body || {};
  if (!b.name || !b.name.trim()) return fail(res, 400, "Employee name is required.");
  const e = await FinanceEmployee.create({
    company, name: b.name.trim(), employeeCode: b.employeeCode, designation: b.designation, department: b.department,
    email: b.email, phone: b.phone, dob: b.dob || null, dateOfJoining: b.dateOfJoining || null,
    bankName: b.bankName, bankAcNo: b.bankAcNo, assets: Array.isArray(b.assets) ? b.assets : [],
    tools: Array.isArray(b.tools) ? b.tools : [], userRef: isId(b.userRef) ? b.userRef : null,
    createdBy: a.id, createdByName: a.name,
  });
  ok(res, { employee: e.toObject() });
}
async function updateEmployee(req, res) {
  const company = companyIdOf(req); const b = req.body || {};
  const allowed = ["name","employeeCode","designation","department","email","phone","dob","dateOfJoining","bankName","bankAcNo","assets","tools","active","userRef"];
  const set = {}; for (const k of allowed) if (k in b) set[k] = b[k];
  const e = await FinanceEmployee.findOneAndUpdate({ _id: req.params.id, company }, { $set: set }, { new: true }).lean();
  if (!e) return fail(res, 404, "Employee not found."); ok(res, { employee: e });
}
async function deleteEmployee(req, res) {
  const company = companyIdOf(req);
  const used = await SalaryRecord.countDocuments({ company, employee: req.params.id });
  if (used > 0) { await FinanceEmployee.updateOne({ _id: req.params.id, company }, { $set: { active: false } }); return ok(res, { deactivated: true, message: "Employee has salary slips — marked inactive instead of deleted." }); }
  const r = await FinanceEmployee.deleteOne({ _id: req.params.id, company });
  if (!r.deletedCount) return fail(res, 404, "Employee not found."); ok(res, { deleted: true });
}

// ── Salary slips ───────────────────────────────────────────────────────────────
async function listSalary(req, res) {
  const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
  const q = { company };
  if (req.query.employee && isId(req.query.employee)) q.employee = req.query.employee;
  if (req.query.payMonth) q.payMonth = String(req.query.payMonth);
  const items = await SalaryRecord.find(q).sort({ payMonth: -1, employeeName: 1 }).lean();
  ok(res, { salaries: items });
}
async function getSalary(req, res) {
  const company = companyIdOf(req); const s = await SalaryRecord.findOne({ _id: req.params.id, company }).lean();
  if (!s) return fail(res, 404, "Salary slip not found."); ok(res, { salary: s });
}
async function createSalary(req, res) {
  const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
  const a = actorOf(req); const b = req.body || {};
  if (!isId(b.employee)) return fail(res, 400, "Employee is required.");
  if (!b.payMonth) return fail(res, 400, "Pay month is required.");
  const emp = await FinanceEmployee.findOne({ _id: b.employee, company }).lean();
  if (!emp) return fail(res, 404, "Employee not found.");
  const doc = new SalaryRecord({
    company, employee: emp._id,
    employeeName: emp.name, designation: emp.designation, department: emp.department, email: emp.email,
    dateOfJoining: emp.dateOfJoining, bankName: emp.bankName, bankAcNo: emp.bankAcNo,
    payMonth: String(b.payMonth), payDays: b.payDays || 0, lopDays: b.lopDays || 0,
    basicSalary: b.basicSalary || 0, incentivePay: b.incentivePay || 0, travelAllowance: b.travelAllowance || 0, otherEarnings: b.otherEarnings || 0,
    lossOfPay: b.lossOfPay || 0, professionalTax: b.professionalTax || 0, otherDeductions: b.otherDeductions || 0,
    transactionId: b.transactionId || "", isNewJoinee: !!b.isNewJoinee, createdBy: a.id, createdByName: a.name,
  });
  doc.recalc();
  try { await doc.save(); } catch (e) { if (e && e.code === 11000) return fail(res, 409, "A salary slip for this employee and month already exists."); throw e; }
  ok(res, { salary: doc.toObject() });
}
async function updateSalary(req, res) {
  const company = companyIdOf(req); const b = req.body || {};
  const s = await SalaryRecord.findOne({ _id: req.params.id, company });
  if (!s) return fail(res, 404, "Salary slip not found.");
  const nums = ["payDays","lopDays","basicSalary","incentivePay","travelAllowance","otherEarnings","lossOfPay","professionalTax","otherDeductions"];
  for (const k of nums) if (k in b) s[k] = Number(b[k]) || 0;
  if ("transactionId" in b) s.transactionId = b.transactionId;
  s.recalc(); await s.save(); ok(res, { salary: s.toObject() });
}
async function markSalaryEmailed(req, res) {
  const company = companyIdOf(req);
  const s = await SalaryRecord.findOneAndUpdate({ _id: req.params.id, company }, { $set: { emailSent: true, emailSentAt: new Date() } }, { new: true }).lean();
  if (!s) return fail(res, 404, "Salary slip not found."); ok(res, { salary: s });
}

// ── Tools & Services ─────────────────────────────────────────────────────────────
async function listTools(req, res) {
  const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
  const items = await FinanceTool.find({ company }).sort({ renewalDate: 1, name: 1 }).lean();
  const now = Date.now();
  const withDue = items.map((t) => ({ ...t, daysToRenewal: t.renewalDate ? Math.ceil((new Date(t.renewalDate).getTime() - now) / 86400000) : null }));
  ok(res, { tools: withDue });
}
async function createTool(req, res) {
  const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
  const a = actorOf(req); const b = req.body || {};
  if (!b.name || !b.name.trim()) return fail(res, 400, "Tool / service name is required.");
  const t = await FinanceTool.create({
    company, name: b.name.trim(), category: b.category, cost: b.cost || 0, currency: b.currency || "INR",
    billingCycle: b.billingCycle || "monthly", reason: b.reason, takenBy: b.takenBy, usedBy: b.usedBy,
    startDate: b.startDate || null, renewalDate: b.renewalDate || null, reminderDays: b.reminderDays ?? 7,
    autoRenews: b.autoRenews !== false, note: b.note, createdBy: a.id, createdByName: a.name,
  });
  ok(res, { tool: t.toObject() });
}
async function updateTool(req, res) {
  const company = companyIdOf(req); const b = req.body || {};
  const allowed = ["name","category","cost","currency","billingCycle","reason","takenBy","usedBy","startDate","renewalDate","reminderDays","autoRenews","note","active"];
  const set = {}; for (const k of allowed) if (k in b) set[k] = b[k];
  const t = await FinanceTool.findOneAndUpdate({ _id: req.params.id, company }, { $set: set }, { new: true }).lean();
  if (!t) return fail(res, 404, "Tool not found."); ok(res, { tool: t });
}
async function deleteTool(req, res) {
  const company = companyIdOf(req); const r = await FinanceTool.deleteOne({ _id: req.params.id, company });
  if (!r.deletedCount) return fail(res, 404, "Tool not found."); ok(res, { deleted: true });
}

// ── Notes (date-wise) ────────────────────────────────────────────────────────────
async function listNotes(req, res) {
  const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
  const items = await FinanceNote.find({ company }).sort({ noteDate: -1, createdAt: -1 }).limit(500).lean();
  ok(res, { notes: items });
}
async function createNote(req, res) {
  const company = companyIdOf(req); if (!company) return fail(res, 400, "Company not resolved.");
  const a = actorOf(req); const b = req.body || {};
  if (!b.description || !b.description.trim()) return fail(res, 400, "Note description is required.");
  const n = await FinanceNote.create({ company, noteDate: b.noteDate || new Date(), description: b.description.trim(), createdBy: a.id, createdByName: a.name });
  ok(res, { note: n.toObject() });
}
async function updateNote(req, res) {
  const company = companyIdOf(req); const b = req.body || {};
  const set = {}; if ("description" in b) set.description = b.description; if ("noteDate" in b) set.noteDate = b.noteDate;
  const n = await FinanceNote.findOneAndUpdate({ _id: req.params.id, company }, { $set: set }, { new: true }).lean();
  if (!n) return fail(res, 404, "Note not found."); ok(res, { note: n });
}
async function deleteNote(req, res) {
  const company = companyIdOf(req); const r = await FinanceNote.deleteOne({ _id: req.params.id, company });
  if (!r.deletedCount) return fail(res, 404, "Note not found."); ok(res, { deleted: true });
}

module.exports = {
  listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee,
  listSalary, getSalary, createSalary, updateSalary, markSalaryEmailed,
  listTools, createTool, updateTool, deleteTool,
  listNotes, createNote, updateNote, deleteNote,
};
