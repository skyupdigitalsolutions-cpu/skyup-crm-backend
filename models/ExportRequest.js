// models/ExportRequest.js
// An admin's request to export leads. A super admin approves or rejects it.
// An approval allows exactly ONE export and expires at midnight (IST) on the
// day it was approved. Consumed atomically by POST /api/lead/admin/export.
const mongoose = require("mongoose");

const exportRequestSchema = new mongoose.Schema(
  {
    company:      { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    admin:        { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
    adminName:    { type: String, default: "" },
    reason:       { type: String, default: "", maxlength: 300 },
    status:       { type: String, enum: ["pending", "approved", "rejected", "used"], default: "pending", index: true },
    decidedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    decidedByName:{ type: String, default: "" },
    decidedAt:    { type: Date, default: null },
    rejectReason: { type: String, default: "", maxlength: 300 },
    expiresAt:    { type: Date, default: null },  // set on approval: 23:59:59 IST that day
    usedAt:       { type: Date, default: null },
    rowCount:     { type: Number, default: null },
  },
  { timestamps: true }
);
exportRequestSchema.index({ company: 1, admin: 1, status: 1 });
exportRequestSchema.index({ company: 1, createdAt: -1 });

module.exports = mongoose.models.ExportRequest || mongoose.model("ExportRequest", exportRequestSchema);
