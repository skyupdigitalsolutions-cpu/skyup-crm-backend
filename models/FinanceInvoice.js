// models/FinanceInvoice.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// One record per invoice in the Finance Dashboard.
//
//   • source "lead"   — auto-created (first record only) when a lead reaches a
//                       "won" status (Customize CRM → Statuses → category "won").
//                       It has NO invoice number: finance types it in by hand.
//   • source "manual" — created by hand from the dashboard.
//
// A CLIENT can have many invoices (one per service engagement). All invoices of
// one client share `clientId`; each has its own number, services and payments.
// Invoice numbers are ALWAYS entered manually — nothing is auto-generated.
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

// One line per service sold on the invoice
const serviceSchema = new mongoose.Schema(
  {
    name:   { type: String, required: true, trim: true, maxlength: 120 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const financeInvoiceSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },

    source: { type: String, enum: ["lead", "manual"], default: "manual" },
    lead:   { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    // Typed in by finance. Empty = "number not added yet" (auto-created lead
    // invoices start like this). Unique per company once filled in.
    invoiceNumber: { type: String, default: "", trim: true },

    // Groups every invoice that belongs to the same client.
    //   lead client   → the lead's _id
    //   manual client → a fresh id shared by that client's invoices
    clientId:    { type: mongoose.Schema.Types.ObjectId, default: null },
    // true only for the one invoice auto-created from a converted lead
    autoCreated: { type: Boolean, default: false },

    // Snapshot of who the invoice is for (kept even if the lead is edited later)
    customerName: { type: String, required: true, trim: true },
    businessName: { type: String, default: "", trim: true },
    // Where the client came from (e.g. Google Ads, Referral) and, for a
    // referral, who referred them.
    clientSource: { type: String, default: "", trim: true, maxlength: 60 },
    referredBy:   { type: String, default: "", trim: true, maxlength: 120 },

    // Services on this invoice (several allowed). `service` is a comma-joined
    // summary of their names, kept for search / old data.
    services:    { type: [serviceSchema], default: [] },
    service:     { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },

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
  // Total = sum of the services once they carry amounts
  const svcSum = (this.services || []).reduce((t, x) => t + (Number(x.amount) || 0), 0);
  if (svcSum > 0) this.totalAmount = Math.round(svcSum * 100) / 100;
  this.service = (this.services || []).map((x) => x.name).filter(Boolean).join(", ") || this.service;
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

// Invoice numbers are unique per company — but only once actually filled in
// (many invoices may be waiting for a number).
financeInvoiceSchema.index(
  { company: 1, invoiceNumber: 1 },
  { unique: true, name: "company_invoiceNumber_unique_nonempty", partialFilterExpression: { invoiceNumber: { $gt: "" } } }
);
// The auto-created record for a converted lead is made exactly once. Extra
// services for the same client are separate (autoCreated:false) invoices.
financeInvoiceSchema.index(
  { company: 1, lead: 1 },
  { unique: true, name: "company_lead_auto_unique", partialFilterExpression: { autoCreated: true } }
);
financeInvoiceSchema.index({ company: 1, clientId: 1 });
financeInvoiceSchema.index({ company: 1, conversionDate: -1 });
financeInvoiceSchema.index({ company: 1, paymentStatus: 1, nextFollowUpDate: 1 });
financeInvoiceSchema.index({ company: 1, assignedTo: 1, nextFollowUpDate: 1 });
// reminder job scan
financeInvoiceSchema.index({ status: 1, paymentStatus: 1, nextFollowUpDate: 1 });

module.exports = mongoose.model("FinanceInvoice", financeInvoiceSchema);
