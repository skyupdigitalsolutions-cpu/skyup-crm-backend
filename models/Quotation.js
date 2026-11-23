// models/Quotation.js — quotations, scoped per company, with a sequential per-company, per-year number.
// Supports BOTH a built quotation (line items) and an uploaded file. Numbers never repeat and only go up
// (gaps allowed). Tracks who handled the client, who approved any discount, and the opted service(s).
const mongoose = require("mongoose");

// A single line on the quotation. lineTotal = qty × unitPrice (computed on save).
const lineItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true, maxlength: 300 },
  quantity:    { type: Number, default: 1, min: 0 },
  unitPrice:   { type: Number, default: 0, min: 0 },
  billing:     { type: String, enum: ["one_time", "monthly", "quarterly", "half_yearly", "yearly"], default: "one_time" },
  lineTotal:   { type: Number, default: 0 },   // qty × unitPrice (computed)
}, { _id: true });

const quotationSchema = new mongoose.Schema({
  company:   { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },

  // Sequential number — unique per company. e.g. "SKY/2026/0001"
  number:    { type: String, required: true, trim: true },
  seq:       { type: Number, required: true },   // the raw sequence (for the year)
  year:      { type: Number, required: true },

  // link to the converted lead / client
  lead:      { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
  clientName:{ type: String, default: "", trim: true },
  clientEmail:{ type: String, default: "", trim: true },
  clientPhone:{ type: String, default: "", trim: true },
  clientCompany:{ type: String, default: "", trim: true },
  clientGSTIN:{ type: String, default: "", trim: true },
  clientAddress:{ type: String, default: "", trim: true },

  // how it was produced
  source:    { type: String, enum: ["created", "uploaded"], default: "created" },
  fileUrl:   { type: String, default: "" },       // for uploaded quotations (the PDF)
  fileName:  { type: String, default: "" },

  // built quotation content
  title:     { type: String, default: "", trim: true },
  lineItems: { type: [lineItemSchema], default: [] },
  optedServices: { type: [String], default: [] },  // service(s) the client opted for

  // money
  currency:  { type: String, default: "INR" },
  oneTimeSubtotal: { type: Number, default: 0 },   // sum of one-time line totals
  recurringSubtotal: { type: Number, default: 0 }, // sum of recurring (per-period) line totals
  discountType:  { type: String, enum: ["none", "percent", "amount"], default: "none" },
  discountValue: { type: Number, default: 0, min: 0 },
  discountAmount:{ type: Number, default: 0 },      // computed, applied to one-time subtotal
  discountedBy:  { type: String, default: "", trim: true },  // who approved/gave the discount
  gstPercent:    { type: Number, default: 0, min: 0, max: 100 },
  gstAmount:     { type: Number, default: 0 },      // computed
  grandTotal:    { type: Number, default: 0 },      // one-time after discount + GST
  monthlyTotal:  { type: Number, default: 0 },      // recurring total (per month, labelled separately)

  // people
  handledBy:   { type: String, default: "", trim: true },   // employee handling the client
  handledByUser:{ type: mongoose.Schema.Types.ObjectId, default: null },

  status:    { type: String, enum: ["draft", "sent", "accepted", "rejected"], default: "draft" },
  remark:    { type: String, default: "", trim: true },

  createdBy:   { type: mongoose.Schema.Types.ObjectId, default: null },
  createdByName:{ type: String, default: "" },
}, { timestamps: true });

quotationSchema.index({ company: 1, number: 1 }, { unique: true });
quotationSchema.index({ company: 1, createdAt: -1 });

// Recompute all money from the line items + discount + GST. Recurring shown separately (per period), not added
// into the one-time grand total — the usual way to quote project cost + a retainer.
quotationSchema.methods.recalc = function () {
  const isRecurring = (b) => b && b !== "one_time";
  let oneTime = 0, recurring = 0;
  for (const li of this.lineItems || []) {
    li.lineTotal = Math.round(((li.quantity || 0) * (li.unitPrice || 0)) * 100) / 100;
    if (isRecurring(li.billing)) recurring += li.lineTotal; else oneTime += li.lineTotal;
  }
  this.oneTimeSubtotal = Math.round(oneTime * 100) / 100;
  this.recurringSubtotal = Math.round(recurring * 100) / 100;

  let disc = 0;
  if (this.discountType === "percent") disc = oneTime * (this.discountValue || 0) / 100;
  else if (this.discountType === "amount") disc = this.discountValue || 0;
  disc = Math.min(disc, oneTime);
  this.discountAmount = Math.round(disc * 100) / 100;

  const afterDisc = oneTime - disc;
  this.gstAmount = Math.round(afterDisc * (this.gstPercent || 0) / 100 * 100) / 100;
  this.grandTotal = Math.round((afterDisc + this.gstAmount) * 100) / 100;
  this.monthlyTotal = this.recurringSubtotal;
  return this;
};

module.exports = mongoose.model("Quotation", quotationSchema);
