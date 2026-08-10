// utils/auditLogger.js
// ─────────────────────────────────────────────────────────────────────────────
// SHARED AUDIT LOG WRITER — for point-events raised directly from controllers
// (login, password reset, user lifecycle, role changes), as opposed to
// middlewares/accessAudit.js, which covers generic CRUD on data resources
// mounted per-router.
//
// Both write to the SAME collection (AccessAuditLog) so there is one audit
// trail, not two. This file exists so the "build an entry from a request"
// logic is written once and reused across every ISO Phase 4 audit event
// (Login Success, Failed Login, Password Reset, User Creation, User
// Deletion, Role Change) — introduced here for Event 1, reused unchanged
// by every event after it.
//
// ISO/IEC 27001:2022 — A.8.15 Logging, A.8.16 Monitoring activities
// ─────────────────────────────────────────────────────────────────────────────

const AccessAuditLog = require("../models/AccessAuditLog");

/**
 * Extract IP address from a request the same way accessAudit.js does, so
 * every audit entry in the system — whether written by the middleware or by
 * this helper — resolves IP identically.
 */
function extractIp(req) {
  return req.ip || req.headers?.["x-forwarded-for"] || req.connection?.remoteAddress || "";
}

/**
 * Extract user-agent the same way accessAudit.js does (truncated to 300 chars
 * to match the schema's existing convention).
 */
function extractUserAgent(req) {
  return String(req.headers?.["user-agent"] || "").slice(0, 300);
}

/**
 * Write one audit log entry. Fire-and-forget by design — exactly like
 * accessAudit.js — because an audit-logging failure must never break or
 * delay the actual user-facing operation (login, password reset, etc.).
 *
 * @param {Object} params
 * @param {string} params.action        - One of the AccessAuditLog action enum values.
 * @param {string} params.resourceType  - e.g. "Auth", "Admin", "User".
 * @param {Object} [params.req]         - Express request, if available (used for IP/UA/method/path).
 * @param {string|ObjectId} [params.actorId]     - Who performed the action.
 * @param {string} [params.actorModel]  - "User" | "Admin" | "SuperAdmin" | "Developer" | "System".
 * @param {string} [params.actorEmail]  - Email of the actor.
 * @param {string} [params.actorRole]   - Role of the actor, if known.
 * @param {string|ObjectId} [params.company]     - Tenant this event relates to.
 * @param {string|ObjectId} [params.resourceId]  - The specific record affected.
 * @param {number} [params.statusCode]  - HTTP status code of the outcome.
 * @param {Object} [params.metadata]    - Extra context merged into `path`, since AccessAuditLog
 *                                         has no dedicated metadata field.
 */
async function logAuditEvent({
  action,
  resourceType = "Auth",
  req = null,
  actorId = null,
  actorModel = "System",
  actorEmail = "",
  actorRole = "",
  company = null,
  resourceId = null,
  statusCode = 0,
  metadata = null,
}) {
  try {
    const entry = {
      actorId,
      actorModel,
      actorEmail,
      actorRole,
      company,
      crossTenant: false,
      action,
      resourceType,
      resourceId,
      recordCount: 1,
      method: req?.method || "",
      path: metadata
        ? `${(req?.originalUrl || req?.path || "").slice(0, 400)} | ${JSON.stringify(metadata).slice(0, 250)}`
        : (req?.originalUrl || req?.path || "").slice(0, 500),
      ip: req ? extractIp(req) : "",
      userAgent: req ? extractUserAgent(req) : "",
      statusCode,
    };

    await AccessAuditLog.create(entry);
  } catch (err) {
    // Never let audit logging break the real operation. Matches the
    // fire-and-forget error-handling convention in middlewares/accessAudit.js.
    console.error(
      `[auditLogger] failed to write audit entry (action=${action}): ${err.name || "Error"}: ${err.message}`
    );
  }
}

module.exports = { logAuditEvent, extractIp, extractUserAgent };