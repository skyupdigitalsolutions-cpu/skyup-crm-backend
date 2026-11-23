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

    updatedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("QuotationSettings", quotationSettingsSchema);
