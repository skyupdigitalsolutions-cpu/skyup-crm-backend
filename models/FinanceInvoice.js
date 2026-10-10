// models/FinanceInvoice.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// One record per invoice in the Finance Dashboard.
//
//   • source "lead"   — auto-created when a lead reaches a "won" status
//                       (Customize CRM → Statuses → category "won").
//   • source "manual" — created by hand from the dashboard.
//
// Money is tracked as a list of part-payments (`payments`). `paidAmount`,
// `balance` and `paymentStatus` are derived from it by recalc() and stored so
// the list / filters / reminder job can query them without recomputing.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    amount:         { type: Number, required: true, min: 0.01 },
    paidOn:         { type: Date, required: true, default: Date.now },
    method:         { type: String, default: "", trim: true },    // cash | upi | bank | cheque | card | other
    reference:      { type: String, default: "", trim: true },    // txn id / cheque no.
    note:           { type: String, default: "", trim: true },
    recordedBy:     { type: mongoose.Schema.Types.ObjectId, default: null },
    recordedByName: { type: String, default: "" },
    recordedAt:     { type: Date, default: Date.now },
  },
  { _id: true }
);

const remarkSchema = new mongoose.Schema(
  {
    text:   { type: String, required: true, trim: true },
    // remark = free note · followup = a follow-up scheduled/changed · system = auto log
    kind:   { type: String, enum: ["remark", "followup", "system"], default: "remark" },
    by:     { type: mongoose.Schema.Types.ObjectId, default: null },
    byName: { type: String, default: "" },
    byRole: { type: String, default: "" },
    at:     { type: Date, default: Date.now },
  },
  { _id: true }
);

const financeInvoiceSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },

    source: { type: String, enum: ["lead", "manual"], default: "manual" },
    lead:   { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    invoiceNumber: { type: String, required: true, trim: true },

    // Snapshot of who the invoice is for (kept even if the lead is edited later)
    customerName: { type: String, required: true, trim: true },
    businessName: { type: String, default: "", trim: true },
    service:      { type: String, default: "", trim: true },
    description:  { type: String, default: "", trim: true },

    // Employee who owns the payment follow-up (gets the reminder)
    assignedTo:     { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignedToName: { type: String, default: "" },
    // Fallbacks when there is no employee: lead's admin, then whoever created it
    assignedAdmin:  { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },

    createdBy: {
      id:   { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, default: "" },
      role: { type: String, default: "" },
    },

    conversionDate: { type: Date, default: Date.now },

    totalAmount:        { type: Number, default: 0, min: 0 },
    installmentsPlanned:{ type: Number, default: null, min: 1 },

    payments:    { type: [paymentSchema], default: [] },
    paidAmount:  { type: Number, default: 0 },
    balance:     { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ["unpaid", "partial", "paid"], default: "unpaid" },

    nextFollowUpDate:     { type: Date, default: null },
    // IST day ("YYYY-MM-DD") on which the reminder last went out for this invoice
    followUpReminderDay:  { type: String, default: null },

    remarks: { type: [remarkSchema], default: [] },

    status:       { type: String, enum: ["active", "cancelled"], default: "active" },
    cancelledAt:  { type: Date, default: null },
    cancelReason: { type: String, default: "" },
  },
  { timestamps: true }
);

// Derive paidAmount / balance / paymentStatus from payments + totalAmount.
financeInvoiceSchema.methods.recalc = function () {
  const paid = (this.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const total = Number(this.totalAmount) || 0;
  this.paidAmount = Math.round(paid * 100) / 100;
  this.balance = Math.max(0, Math.round((total - paid) * 100) / 100);
  if (total > 0 && paid >= total - 0.005) this.paymentStatus = "paid";
  else if (paid > 0) this.paymentStatus = "partial";
  else this.paymentStatus = "unpaid";
  // A fully-paid invoice has nothing left to chase
  if (this.paymentStatus === "paid") this.nextFollowUpDate = null;
  return this;
};

financeInvoiceSchema.index({ company: 1, invoiceNumber: 1 }, { unique: true });
// One invoice per converted lead (manual invoices have lead:null and are excluded)
financeInvoiceSchema.index(
  { company: 1, lead: 1 },
  { unique: true, partialFilterExpression: { lead: { $type: "objectId" } } }
);
financeInvoiceSchema.index({ company: 1, conversionDate: -1 });
financeInvoiceSchema.index({ company: 1, paymentStatus: 1, nextFollowUpDate: 1 });
financeInvoiceSchema.index({ company: 1, assignedTo: 1, nextFollowUpDate: 1 });
// reminder job scan
financeInvoiceSchema.index({ status: 1, paymentStatus: 1, nextFollowUpDate: 1 });

module.exports = mongoose.model("FinanceInvoice", financeInvoiceSchema);
