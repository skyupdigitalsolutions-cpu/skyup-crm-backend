// models/FinanceSettings.js — NEW FILE
// Per-company settings for the Finance Dashboard (one document per company).
const mongoose = require("mongoose");

const financeSettingsSchema = new mongoose.Schema(
  {
    company:       { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
    // Invoice numbers are issued as <PREFIX>-0001, <PREFIX>-0002, …
    invoicePrefix: { type: String, default: "INV", trim: true, uppercase: true, maxlength: 10 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FinanceSettings", financeSettingsSchema);
