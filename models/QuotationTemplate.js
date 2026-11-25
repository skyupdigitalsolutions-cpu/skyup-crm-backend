// models/QuotationTemplate.js — reusable quotation content ("Start from template").
// Holds everything a quotation says except who it's for: items, deliverables,
// optional items, tables, milestones, timeline, terms, discount, GST and design.
const mongoose = require("mongoose");

const quotationTemplateSchema = new mongoose.Schema(
  {
    company:     { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    name:        { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", trim: true, maxlength: 300 },
    content:     { type: mongoose.Schema.Types.Mixed, default: {} },   // cleaned with quotationController.contentFrom
    createdByName: { type: String, default: "" },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true }
);
quotationTemplateSchema.index({ company: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("QuotationTemplate", quotationTemplateSchema);
