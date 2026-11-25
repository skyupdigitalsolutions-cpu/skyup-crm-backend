// models/QuotationSettings.js — per-company look of printed quotations.
// The letterhead is an A4 image (PNG/JPG/WEBP) printed behind every page;
// the margins keep the quotation text inside the letterhead's blank area.
const mongoose = require("mongoose");

const quotationSettingsSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },

    letterheadUrl:  { type: String, default: "" },
    letterheadName: { type: String, default: "" },
    // Space (mm) the letterhead's own header / footer / side art takes up on A4.
    marginTopMm:    { type: Number, default: 40, min: 0, max: 150 },
    marginBottomMm: { type: Number, default: 25, min: 0, max: 150 },
    marginSideMm:   { type: Number, default: 15, min: 5, max: 60 },
    // The letterhead usually already shows the logo / name — hide ours.
    hideBuiltInHeader: { type: Boolean, default: true },

    // ── document ──────────────────────────────────────────────────────────
    documentTitle: { type: String, default: "Quotation", trim: true, maxlength: 40 },   // or "Proposal", "Estimate"
    numberPrefix:  { type: String, default: "SKY", trim: true, uppercase: true, maxlength: 12 },
    // ── defaults for new quotations ───────────────────────────────────────
    currency:          { type: String, default: "INR", trim: true, uppercase: true, maxlength: 3 },
    defaultGstPercent: { type: Number, default: 18, min: 0, max: 100 },
    validityDays:      { type: Number, default: 15, min: 0, max: 365 },
    defaultTerms:        { type: String, default: "", trim: true, maxlength: 10000 },
    defaultPaymentTerms: { type: String, default: "", trim: true, maxlength: 5000 },
    defaultServiceInfo:  { type: String, default: "", trim: true, maxlength: 8000 },
    // ── look ──────────────────────────────────────────────────────────────
    layoutStyle: { type: String, enum: ["classic", "modern", "minimal"], default: "classic" },
    accentColor: { type: String, default: "#1F3A8A", trim: true, match: /^#[0-9a-fA-F]{6}$/ },
    fontFamily:  { type: String, enum: ["arial", "helvetica", "georgia", "times", "verdana", "trebuchet", "segoe"], default: "arial" },
    // { index|billing|qty|unitPrice|amount|description: { show, label } } — sanitised in the controller
    columns:  { type: mongoose.Schema.Types.Mixed, default: {} },
    // [{ key, label, show }] in print order — sanitised in the controller
    sections: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // ── signature / stamp ─────────────────────────────────────────────────
    stampUrl:       { type: String, default: "" },
    signatoryName:  { type: String, default: "", trim: true, maxlength: 80 },
    signatoryTitle: { type: String, default: "", trim: true, maxlength: 80 },
    // ── your company (header, footer bar, bank block) ─────────────────────
    companyName:    { type: String, default: "", trim: true, maxlength: 120 },
    companyAddress: { type: String, default: "", trim: true, maxlength: 400 },
    companyGstin:   { type: String, default: "", trim: true, uppercase: true, maxlength: 20 },
    companyPhone:   { type: String, default: "", trim: true, maxlength: 40 },
    companyEmail:   { type: String, default: "", trim: true, maxlength: 120 },
    companyWebsite: { type: String, default: "", trim: true, maxlength: 120 },
    defaultAboutUs: { type: String, default: "", trim: true, maxlength: 5000 },
    bankDetails:    { type: String, default: "", trim: true, maxlength: 1000 },
    qrUrl:          { type: String, default: "" },        // UPI / PhonePe QR image
    qrCaption:      { type: String, default: "", trim: true, maxlength: 80 },
    // ── options ───────────────────────────────────────────────────────────
    showFooterBar:    { type: Boolean, default: true },   // phone · website · email on every page
    numberedHeadings: { type: Boolean, default: false },  // "01 Project overview"
    clientSignature:  { type: Boolean, default: true },   // "For <client> — Authorised signatory"
    showGstSuffix:    { type: Boolean, default: false },  // "₹2,999 + GST" in the items table
    coverPageDefault: { type: Boolean, default: false },  // new quotations start with a cover page

    // ── saved services with prices (pick list in the form) ────────────────
    catalog: {
      type: [{
        name:      { type: String, required: true, trim: true, maxlength: 300 },
        details:   { type: String, default: "", trim: true, maxlength: 3000 },
        unitPrice: { type: Number, default: 0, min: 0 },
        billing:   { type: String, enum: ["one_time", "monthly", "quarterly", "half_yearly", "yearly"], default: "one_time" },
        module:    { type: String, default: "", trim: true, maxlength: 80 },
        category:  { type: String, default: "", trim: true, maxlength: 60 },   // "CRM Packages", "Digital Marketing"…
        note:      { type: String, default: "", trim: true, maxlength: 120 },  // under the price: "(5 - 6 pages)", "Custom Pricing"
      }],
      default: [],
    },

    // ── extra designs (the top-level look above is the "Standard" design) ─
    // Each: { name, look: { documentTitle, layoutStyle, accentColor, fontFamily,
    // columns, sections, letterheadUrl, margins…, stampUrl, signatory…, options } }
    // — cleaned in the controller. Company details, defaults and saved services
    // are shared by every design.
    standardDesignName: { type: String, default: "Standard", trim: true, maxlength: 40 },
    designs: {
      type: [{ name: { type: String, required: true, trim: true, maxlength: 40 }, look: { type: mongoose.Schema.Types.Mixed, default: {} } }],
      default: [],
    },

    updatedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("QuotationSettings", quotationSettingsSchema);
