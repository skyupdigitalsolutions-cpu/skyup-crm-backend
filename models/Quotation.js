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
  details:     { type: String, default: "", trim: true, maxlength: 3000 },  // key deliverables under the description
  module:      { type: String, default: "", trim: true, maxlength: 80 },    // group for module-wise payment
  priceLabel:  { type: String, default: "", trim: true, maxlength: 80 },    // shown instead of the amount: "Included", "₹199 per product"
  chargeNote:  { type: String, default: "", trim: true, maxlength: 120 },   // small line under the charge: "(5 - 6 pages)"
}, { _id: true });

// Optional add-ons: shown on the quotation, NOT counted in the totals.
const optionalItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true, maxlength: 300 },
  details:     { type: String, default: "", trim: true, maxlength: 3000 },
  quantity:    { type: Number, default: 1, min: 0 },
  unitPrice:   { type: Number, default: 0, min: 0 },
  billing:     { type: String, enum: ["one_time", "monthly", "quarterly", "half_yearly", "yearly"], default: "one_time" },
  lineTotal:   { type: Number, default: 0 },
  priceLabel:  { type: String, default: "", trim: true, maxlength: 80 },
  chargeNote:  { type: String, default: "", trim: true, maxlength: 120 },
}, { _id: true });

// Headline boxes ("Project investment ₹7,08,000", "Delivery 10–14 weeks").
const highlightSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true, maxlength: 40 },
  value: { type: String, default: "", trim: true, maxlength: 40 },
  note:  { type: String, default: "", trim: true, maxlength: 60 },
}, { _id: false });

// Free-form tables: running costs, rate cards, comparisons, key–value terms…
const customTableSchema = new mongoose.Schema({
  title:   { type: String, default: "", trim: true, maxlength: 120 },
  note:    { type: String, default: "", trim: true, maxlength: 1000 },
  columns: { type: [String], default: [] },                 // 1–6 headings
  rows:    { type: [{ cells: { type: [String], default: [] } }], default: [] },
}, { _id: true });

const timelineSchema = new mongoose.Schema({
  phase:    { type: String, required: true, trim: true, maxlength: 150 },
  duration: { type: String, default: "", trim: true, maxlength: 60 },   // "2 weeks", "Day 1–10"
  details:  { type: String, default: "", trim: true, maxlength: 600 },
}, { _id: true });

// Payment schedule / module-wise payment breakdown. percent > 0 → amount is
// percent of the grand total (recomputed on save); otherwise amount as typed.
const paymentRowSchema = new mongoose.Schema({
  label:   { type: String, required: true, trim: true, maxlength: 150 },  // "Advance", "Module 2: CRM"
  percent: { type: Number, default: 0, min: 0, max: 100 },
  amount:  { type: Number, default: 0, min: 0 },
  due:     { type: String, default: "", trim: true, maxlength: 80 },     // "On signing", "15 Jan 2027"
}, { _id: true });

const customBlockSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  body:  { type: String, default: "", trim: true, maxlength: 5000 },
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

  // ── extra sections (each can be hidden / renamed / reordered per company) ──
  optionalItems:   { type: [optionalItemSchema], default: [] },
  scopeOfWork:     { type: String, default: "", trim: true, maxlength: 8000 },
  timeline:        { type: [timelineSchema], default: [] },
  paymentSchedule: { type: [paymentRowSchema], default: [] },
  serviceInfo:     { type: String, default: "", trim: true, maxlength: 8000 },   // other service information
  suggestions:     { type: String, default: "", trim: true, maxlength: 5000 },
  terms:           { type: String, default: "", trim: true, maxlength: 10000 },  // terms & conditions
  paymentTerms:    { type: String, default: "", trim: true, maxlength: 5000 },   // payment conditions
  customBlocks:    { type: [customBlockSchema], default: [] },                   // any other optional details
  validUntil:      { type: Date, default: null },
  introduction:    { type: String, default: "", trim: true, maxlength: 8000 },  // project overview / executive summary
  aboutUs:         { type: String, default: "", trim: true, maxlength: 5000 },
  highlights:      { type: [highlightSchema], default: [] },
  customTables:    { type: [customTableSchema], default: [] },
  coverPage:       { type: Boolean, default: false },
  coverSubtitle:   { type: String, default: "", trim: true, maxlength: 300 },
  showTotals:      { type: Boolean, default: true },   // off for rate-card quotations
  designId:        { type: mongoose.Schema.Types.ObjectId, default: null },   // null = the Standard design

  createdBy:   { type: mongoose.Schema.Types.ObjectId, default: null },
  createdByName:{ type: String, default: "" },
}, { timestamps: true });

quotationSchema.index({ company: 1, number: 1 }, { unique: true });
quotationSchema.index({ company: 1, createdAt: -1 });

// Recompute all money from the line items + discount + GST. Recurring shown separately (per period), not added
// into the one-time grand total — the usual way to quote project cost + a retainer.
// Every figure is rounded to paise BEFORE it is used, so the printed lines
// always add up: total = subtotal − discount + GST. The frontend
// (components/quotation/quotationTemplate.js → computeTotals) uses the exact
// same steps — keep the two in step.
const r2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

quotationSchema.methods.recalc = function () {
  const isRecurring = (b) => b && b !== "one_time";
  let oneTime = 0, recurring = 0;
  for (const li of this.lineItems || []) {
    li.lineTotal = r2((li.quantity || 0) * (li.unitPrice || 0));
    if (isRecurring(li.billing)) recurring += li.lineTotal; else oneTime += li.lineTotal;
  }
  oneTime = r2(oneTime);
  this.oneTimeSubtotal = oneTime;
  this.recurringSubtotal = r2(recurring);

  let disc = 0;
  if (this.discountType === "percent") disc = oneTime * (this.discountValue || 0) / 100;
  else if (this.discountType === "amount") disc = this.discountValue || 0;
  disc = r2(Math.min(Math.max(disc, 0), oneTime));
  this.discountAmount = disc;

  const taxable = r2(oneTime - disc);
  this.gstAmount = r2(taxable * (this.gstPercent || 0) / 100);
  this.grandTotal = r2(taxable + this.gstAmount);
  this.monthlyTotal = this.recurringSubtotal;

  for (const oi of this.optionalItems || []) {
    oi.lineTotal = r2((oi.quantity || 0) * (oi.unitPrice || 0));
  }
  for (const pr of this.paymentSchedule || []) {
    if ((pr.percent || 0) > 0) pr.amount = r2(this.grandTotal * pr.percent / 100);
  }
  return this;
};

module.exports = mongoose.model("Quotation", quotationSchema);
