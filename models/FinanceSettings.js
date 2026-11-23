// models/FinanceSettings.js — NEW FILE
// Per-company settings for the Finance Dashboard (one document per company).
const mongoose = require("mongoose");

const financeSettingsSchema = new mongoose.Schema(
  {
    company:       { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
    // Invoice numbers are issued as <PREFIX>-0001, <PREFIX>-0002, …
    invoicePrefix: { type: String, default: "INV", trim: true, uppercase: true, maxlength: 10 },

    // ── "From" block printed on downloadable invoices ──────────────────────
    // Blank fields fall back to the company record (name, address, phone, email).
    legalName:   { type: String, default: "", trim: true, maxlength: 120 },
    gstin:       { type: String, default: "", trim: true, uppercase: true, maxlength: 20 },
    address:     { type: String, default: "", trim: true, maxlength: 400 },
    phone:       { type: String, default: "", trim: true, maxlength: 40 },
    email:       { type: String, default: "", trim: true, maxlength: 120 },
    bankDetails: { type: String, default: "", trim: true, maxlength: 600 },   // multi-line: bank, A/C, IFSC, UPI
    terms:       { type: String, default: "", trim: true, maxlength: 1000 },  // printed under the totals
    signatory:   { type: String, default: "", trim: true, maxlength: 120 },   // "For Acme Pvt Ltd"
  },
  { timestamps: true }
);

module.exports = mongoose.model("FinanceSettings", financeSettingsSchema);
