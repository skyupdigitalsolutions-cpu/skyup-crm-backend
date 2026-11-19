// models/SalaryRecord.js — one salary slip for a FinanceEmployee, per company, per pay month.
// Ported from the standalone salary app's SalaryRecord. Totals are computed and stored by recalc().
const mongoose = require("mongoose");

const salaryRecordSchema = new mongoose.Schema({
  company:       { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  employee:      { type: mongoose.Schema.Types.ObjectId, ref: "FinanceEmployee", required: true, index: true },

  // snapshot (kept even if the employee record changes later)
  employeeName:  { type: String, required: true, trim: true },
  designation:   { type: String, default: "", trim: true },
  department:    { type: String, default: "", trim: true },
  email:         { type: String, default: "", trim: true },
  dateOfJoining: { type: Date, default: null },
  bankName:      { type: String, default: "", trim: true },
  bankAcNo:      { type: String, default: "", trim: true },

  payMonth:      { type: String, required: true, trim: true },   // "2026-10"
  payDays:       { type: Number, default: 0, min: 0 },
  lopDays:       { type: Number, default: 0, min: 0 },

  basicSalary:     { type: Number, default: 0, min: 0 },
  incentivePay:    { type: Number, default: 0, min: 0 },
  travelAllowance: { type: Number, default: 0, min: 0 },
  otherEarnings:   { type: Number, default: 0, min: 0 },

  lossOfPay:       { type: Number, default: 0, min: 0 },
  professionalTax: { type: Number, default: 0, min: 0 },
  otherDeductions: { type: Number, default: 0, min: 0 },

  totalEarnings:   { type: Number, default: 0 },
  totalDeductions: { type: Number, default: 0 },
  netSalary:       { type: Number, default: 0 },

  transactionId:   { type: String, default: "", trim: true },
  emailSent:       { type: Boolean, default: false },
  emailSentAt:     { type: Date, default: null },
  isNewJoinee:     { type: Boolean, default: false },

  createdBy:     { type: mongoose.Schema.Types.ObjectId, default: null },
  createdByName: { type: String, default: "" },
}, { timestamps: true });

// one slip per employee per month per company
salaryRecordSchema.index({ company: 1, employee: 1, payMonth: 1 }, { unique: true });

salaryRecordSchema.methods.recalc = function () {
  this.totalEarnings   = (this.basicSalary || 0) + (this.incentivePay || 0) + (this.travelAllowance || 0) + (this.otherEarnings || 0);
  this.totalDeductions = (this.lossOfPay || 0) + (this.professionalTax || 0) + (this.otherDeductions || 0);
  this.netSalary       = this.totalEarnings - this.totalDeductions;
  return this;
};
module.exports = mongoose.model("SalaryRecord", salaryRecordSchema);
