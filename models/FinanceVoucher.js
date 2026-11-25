// models/FinanceVoucher.js — Finance dashboard → Payment vouchers.
// The printed voucher (same layout as the paper voucher book) is produced from
// this record; the "Particulars" block (received by / prepared by / authorised)
// is left blank on print for names and signatures by hand.
const mongoose = require("mongoose");

const lineSchema = new mongoose.Schema({
  date:    { type: Date, default: null },
  details: { type: String, required: true, trim: true, maxlength: 300 },
  amount:  { type: Number, required: true, min: 0 },
}, { _id: true });

const financeVoucherSchema = new mongoose.Schema(
  {
    company:  { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    voucherNo: { type: String, required: true },          // PV/2026-27/0001
    seq:       { type: Number, required: true },
    fy:        { type: String, required: true },          // "2026-27" (April–March)
    voucherDate:      { type: Date, required: true },
    debitAccountHead: { type: String, required: true, trim: true, maxlength: 120 },
    paidTo:           { type: String, default: "", trim: true, maxlength: 120 },   // for the register only — not printed
    lines:            { type: [lineSchema], default: [] },
    total:        { type: Number, default: 0 },
    tdsPercent:   { type: Number, default: 0, min: 0, max: 100 },
    tdsAmount:    { type: Number, default: 0 },
    payableTotal: { type: Number, default: 0 },
    amountInWords: { type: String, default: "" },
    paymentMode:  { type: String, enum: ["cash", "cheque", "online"], default: "cash" },
    paymentRef:   { type: String, default: "", trim: true, maxlength: 120 },          // cheque no. / UTR / UPI ref
    status:       { type: String, enum: ["active", "cancelled"], default: "active" },
    cancelReason: { type: String, default: "", trim: true, maxlength: 300 },
    createdBy:     { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, default: "" },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true }
);
financeVoucherSchema.index({ company: 1, voucherNo: 1 }, { unique: true });
financeVoucherSchema.index({ company: 1, voucherDate: -1 });

module.exports = mongoose.model("FinanceVoucher", financeVoucherSchema);
