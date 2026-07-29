// middlewares/accessAudit.js
// ─────────────────────────────────────────────────────────────────────────────
// PERSONAL-DATA ACCESS AUDIT MIDDLEWARE
// ISO/IEC 27001:2022 — A.8.15 Logging, A.8.16 Monitoring activities
//
// Mount this ONCE on the routers that serve personal data and every request is
// logged automatically. Doing it here rather than in each controller means new
// routes are covered by default — coverage cannot drift.
//
//   const { auditAccess } = require("./middlewares/accessAudit");
//   app.use("/api/lead",   auditAccess({ resourceType: "Lead" }));
//   app.use("/api/report", auditAccess({ resourceType: "Report" }));
//
// The log write happens AFTER the response is sent (on the "finish" event), so
// it never slows the request down and never fails it.
// ─────────────────────────────────────────────────────────────────────────────

const AccessAuditLog = require("../models/AccessAuditLog");

// Read-heavy endpoints that return many records are the ones worth alerting on.
const BULK_ALERT_THRESHOLD = Number(process.env.AUDIT_BULK_THRESHOLD) || 250;

// Map an HTTP method + path to an audit action.
function deriveAction(req) {
  const p = String(req.originalUrl || req.path || "").toLowerCase();
  if (p.includes("export") || p.includes("download") || p.includes("csv")) return "export";
  switch (req.method) {
    case "POST":   return "create";
    case "PUT":
    case "PATCH":  return "update";
    case "DELETE": return "delete";
    case "GET":    return req.params && req.params.id ? "view" : "list";
    default:       return "view";
  }
}

// Resolve the acting identity. protectAny populates different properties per
// role (req.user for employees/admins, req.admin/req.superAdmin for super
// admins), so read all of them defensively.
function resolveActor(req) {
  const u = req.user || {};
  const a = req.admin || {};
  const isSuper = !!req.superAdmin || a.role === "super_admin";
  const actorId = u.userId || u.id || u._id || a._id || null;
  const role    = u.role || a.role || "";

  // The company can arrive in several shapes depending on which middleware ran:
  //   • protectAny (admin)    → req.user.companyId (string)
  //   • protectAny (employee) → req.user.companyId (string)
  //   • protect               → req.user IS the Mongoose doc, so .company (ObjectId)
  //   • super admin           → req.callerCompany / req.admin.company
  // Checking only companyId left `company: null` on a lot of records, which
  // makes a multi-tenant audit trail far less useful — an auditor needs to know
  // WHOSE data was touched.
  const company =
    u.companyId ||
    (u.company && (u.company._id || u.company)) ||
    req.callerCompany ||
    (a.company && (a.company._id || a.company)) ||
    null;

  return {
    actorId,
    actorRole: role,
    actorEmail: u.email || a.email || "",
    actorModel: isSuper ? "SuperAdmin" : role === "admin" ? "Admin" : actorId ? "User" : "System",
    company,
    isSuper,
  };
}

// Best-effort count of how many records a response returned.
function countRecords(body) {
  try {
    if (!body) return 1;
    if (Array.isArray(body)) return body.length;
    for (const k of ["leads", "data", "results", "items", "rows"]) {
      if (Array.isArray(body[k])) return body[k].length;
    }
    if (typeof body.total === "number") return body.total;
    return 1;
  } catch (_) { return 1; }
}

function auditAccess(options = {}) {
  const resourceType = options.resourceType || "Lead";

  return function auditAccessMiddleware(req, res, next) {
    // Capture the response payload size without buffering large bodies: we only
    // inspect the object handed to res.json().
    let recordCount = 1;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      recordCount = countRecords(body);
      return originalJson(body);
    };

    res.on("finish", () => {
      // Don't log health checks / static assets / preflight.
      if (req.method === "OPTIONS") return;

      const actor = resolveActor(req);
      const action = res.statusCode === 401 || res.statusCode === 403 ? "denied" : deriveAction(req);

      const entry = {
        actorId:    actor.actorId,
        actorModel: actor.actorModel,
        actorEmail: actor.actorEmail,
        actorRole:  actor.actorRole,
        company:    actor.company,
        // A super admin operating inside a tenant is inherently cross-tenant
        // access and should stand out in the log.
        // Flag both super-admin activity and any request that had to INFER a
        // tenant (missing x-company-id) — the latter is what STRICT_TENANT_CONTEXT
        // will eventually reject, so these entries show what still needs fixing.
        crossTenant: actor.isSuper || !!req.inferredTenant,
        action,
        resourceType,
        resourceId: (req.params && req.params.id) || null,
        recordCount,
        method:     req.method,
        path:       (req.originalUrl || req.path || "").slice(0, 500),
        // Requires app.set("trust proxy", …), which this server already sets.
        ip:         req.ip || req.headers["x-forwarded-for"] || req.connection?.remoteAddress || "",
        userAgent:  String(req.headers["user-agent"] || "").slice(0, 300),
        statusCode: res.statusCode,
      };

      // Alert on unusually large reads/exports — A.8.16 monitoring.
      if ((action === "export" || action === "list") && recordCount >= BULK_ALERT_THRESHOLD) {
        console.warn(
          `[AUDIT-ALERT] Bulk ${action} of ${recordCount} ${resourceType} records by ` +
          `${entry.actorEmail || entry.actorId || "unknown"} (${entry.actorRole || "?"}) ` +
          `from ${entry.ip} — ${entry.path}`
        );
      }

      // Fire-and-forget: auditing must never break or slow the request.
      AccessAuditLog.create(entry).catch((err) =>
        // Include the error type and any validation detail — a bare message
        // previously made this hard to diagnose from logs alone.
        console.error(
          `[accessAudit] failed to write audit entry: ${err.name || "Error"}: ${err.message}` +
          (err.errors ? ` | fields: ${Object.keys(err.errors).join(", ")}` : "")
        )
      );
    });

    next();
  };
}

module.exports = { auditAccess };