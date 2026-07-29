// models/AccessAuditLog.js
// ─────────────────────────────────────────────────────────────────────────────
// PERSONAL-DATA ACCESS AUDIT LOG
// ISO/IEC 27001:2022 — A.8.15 Logging, A.8.16 Monitoring activities
//
// EntitlementAuditLog only covers billing/plan actions. Nothing recorded who
// viewed, exported, edited or deleted a LEAD — and leads are personal data.
// For a multi-tenant CRM that is normally the largest single audit finding.
//
// Design notes:
//  • Append-only. Updates and deletes are blocked at the schema layer, so a
//    compromised app path cannot quietly rewrite history.
//  • Written from middleware (middlewares/accessAudit.js) rather than
//    per-controller, so coverage cannot drift as new routes are added.
//  • `expiresAt` drives a TTL index so the retention period is enforced by the
//    database rather than by a script someone forgets to run.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

// Retention for audit records. Keep at least 12 months for audit usefulness.
const RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS) || 400;

const accessAuditLogSchema = new mongoose.Schema(
  {
    // ── Who ──────────────────────────────────────────────────────────────────
    actorId:    { type: mongoose.Schema.Types.ObjectId, index: true, default: null },
    actorModel: { type: String, enum: ["User", "Admin", "SuperAdmin", "Developer", "System"], default: "System" },
    actorEmail: { type: String, default: "" },
    actorRole:  { type: String, default: "" },

    // ── Which tenant ─────────────────────────────────────────────────────────
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true, default: null },
    // True when a super admin acted on a company other than their own. These
    // are the events an auditor will want to review first.
    crossTenant: { type: Boolean, default: false, index: true },

    // ── What ─────────────────────────────────────────────────────────────────
    action: {
      type: String,
      required: true,
      enum: ["view", "list", "export", "create", "update", "delete", "login", "denied"],
      index: true,
    },
    resourceType: { type: String, default: "Lead", index: true },
    resourceId:   { type: mongoose.Schema.Types.ObjectId, default: null },
    // Number of records touched — a list/export of 5,000 leads is far more
    // significant than a single record view.
    recordCount:  { type: Number, default: 1 },

    // ── Request context ──────────────────────────────────────────────────────
    method:    { type: String, default: "" },
    path:      { type: String, default: "" },
    ip:        { type: String, default: "" },
    userAgent: { type: String, default: "" },
    statusCode:{ type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now, index: true },
    // TTL — MongoDB removes the document once this timestamp passes.
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + RETENTION_DAYS * 86400000),
      index: { expires: 0 },
    },
  },
  { versionKey: false }
);

// Common audit queries: "everything this actor did", "everything in this
// tenant recently", "all bulk exports".
accessAuditLogSchema.index({ company: 1, createdAt: -1 });
accessAuditLogSchema.index({ actorId: 1, createdAt: -1 });
accessAuditLogSchema.index({ action: 1, recordCount: -1, createdAt: -1 });

// ── Append-only enforcement ──────────────────────────────────────────────────
// An audit trail that can be edited is not an audit trail.
const blockWrite = function (next) {
  next(new Error("AccessAuditLog is append-only: updates and deletes are not permitted."));
};
["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete"]
  .forEach((op) => accessAuditLogSchema.pre(op, blockWrite));
accessAuditLogSchema.pre("save", function (next) {
  if (!this.isNew) return next(new Error("AccessAuditLog records are immutable."));
  next();
});

module.exports = mongoose.model("AccessAuditLog", accessAuditLogSchema);