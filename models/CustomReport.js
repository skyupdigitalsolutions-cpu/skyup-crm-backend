// models/CustomReport.js
// Super-admin "custom report": a per-company snapshot of financial fields over a
// custom date range. Fields are FREE-FORM by name, but each carries a TYPE tag
// (revenue / cost / profit / other) so the system can compute real financial
// metrics — net profit, margin, ROI, loss% — instead of only summing numbers.
const mongoose = require("mongoose");

const FIELD_TYPES = ["revenue", "cost", "profit", "other"];

const reportFieldSchema = new mongoose.Schema(
  {
    // Free-form field name as typed by the super admin (e.g. "Ad spend").
    name:  { type: String, required: true, trim: true },
    // Numeric value. Negative allowed (e.g. an explicit loss).
    value: { type: Number, required: true, default: 0 },
    // Financial role of this field — drives the computed metrics below.
    //   revenue → money in;  cost → money out (investment/expense/loss);
    //   profit  → an explicitly-provided profit figure;  other → informational.
    type:  { type: String, enum: FIELD_TYPES, default: "other" },
    note:  { type: String, default: "", trim: true },
  },
  { _id: false }
);

const customReportSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId, ref: "Company",
      required: true, index: true,
    },
    title: { type: String, required: true, trim: true },

    periodStart: { type: Date, required: true },
    periodEnd:   { type: Date, required: true },

    currency: { type: String, default: "₹", trim: true },

    fields: { type: [reportFieldSchema], default: [] },

    // ── Cached analytics (recomputed on every save) ───────────────────────────
    analytics: {
      // Generic
      total:    { type: Number, default: 0 }, // raw sum of all field values
      absTotal: { type: Number, default: 0 },
      breakdown: {
        type: [new mongoose.Schema({ name: String, value: Number, type: String, sharePct: Number }, { _id: false })],
        default: [],
      },
      // Financial (from type tags)
      totalRevenue: { type: Number, default: 0 },
      totalCost:    { type: Number, default: 0 },
      // netProfit = explicit profit fields if present, else revenue - cost
      netProfit:    { type: Number, default: 0 },
      // margin% = netProfit / revenue * 100
      marginPct:    { type: Number, default: null },
      // roi% = netProfit / cost * 100
      roiPct:       { type: Number, default: null },
      // loss% = |netProfit| / revenue * 100 when net is negative
      lossPct:      { type: Number, default: null },
      // verdict: 'profit' | 'loss' | 'breakeven' | 'insufficient'
      verdict:      { type: String, default: "insufficient" },
    },

    // ── Cached AI output ──────────────────────────────────────────────────────
    ai: {
      summary:     { type: String, default: "" },
      suggestions: { type: [String], default: [] },
      verdict:     { type: String, default: "" }, // one-line AI verdict
      generatedAt: { type: Date, default: null },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "SuperAdmin", default: null },
  },
  { timestamps: true }
);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

customReportSchema.pre("validate", function () {
  const fields = this.fields || [];

  const total    = fields.reduce((s, f) => s + (Number(f.value) || 0), 0);
  const absTotal = fields.reduce((s, f) => s + Math.abs(Number(f.value) || 0), 0);

  const totalRevenue = fields.filter(f => f.type === "revenue").reduce((s, f) => s + (Number(f.value) || 0), 0);
  const totalCost    = fields.filter(f => f.type === "cost").reduce((s, f) => s + Math.abs(Number(f.value) || 0), 0);
  const explicitProfit = fields.filter(f => f.type === "profit");
  const hasExplicitProfit = explicitProfit.length > 0;
  const explicitProfitSum = explicitProfit.reduce((s, f) => s + (Number(f.value) || 0), 0);

  // Net profit: prefer explicit profit fields; otherwise revenue − cost.
  const netProfit = hasExplicitProfit ? explicitProfitSum : (totalRevenue - totalCost);

  const hasRev  = totalRevenue > 0;
  const hasCost = totalCost > 0;
  const canDerive = hasRev || hasCost || hasExplicitProfit;

  const marginPct = hasRev ? r2((netProfit / totalRevenue) * 100) : null;
  const roiPct    = hasCost ? r2((netProfit / totalCost) * 100) : null;
  const lossPct   = (hasRev && netProfit < 0) ? r2((Math.abs(netProfit) / totalRevenue) * 100) : null;

  let verdict = "insufficient";
  if (canDerive) {
    if (netProfit > 0)       verdict = "profit";
    else if (netProfit < 0)  verdict = "loss";
    else                     verdict = "breakeven";
  }

  this.analytics = {
    total: r2(total),
    absTotal: r2(absTotal),
    breakdown: fields.map(f => {
      const v = Number(f.value) || 0;
      return { name: f.name, value: v, type: f.type || "other", sharePct: absTotal > 0 ? r2((Math.abs(v) / absTotal) * 100) : 0 };
    }),
    totalRevenue: r2(totalRevenue),
    totalCost:    r2(totalCost),
    netProfit:    r2(netProfit),
    marginPct, roiPct, lossPct, verdict,
  };
});

module.exports = mongoose.model("CustomReport", customReportSchema);
module.exports.FIELD_TYPES = FIELD_TYPES;
