// models/FinanceNote.js — simple date-wise notes for the Finance dashboard. Per company.
const mongoose = require("mongoose");

const financeNoteSchema = new mongoose.Schema({
  company:     { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
  noteDate:    { type: Date, required: true, default: Date.now, index: true },   // the day the note is filed under
  description: { type: String, required: true, trim: true, maxlength: 4000 },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, default: null },
  createdByName:{ type: String, default: "" },
}, { timestamps: true });

financeNoteSchema.index({ company: 1, noteDate: -1 });
module.exports = mongoose.model("FinanceNote", financeNoteSchema);
