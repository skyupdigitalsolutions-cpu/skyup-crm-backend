// middlewares/sheetIntegrationAccess.js — NEW
// ─────────────────────────────────────────────────────────────────────────────
// Server-side enforcement for the Employee Excel / Google Sheet integration.
//
// The spec is explicit (Sections 2 & 8): DO NOT rely on frontend visibility.
// Every API must validate authenticated user + companyId + employeeId + feature
// enabled. These factories do exactly that, reusing the existing entitlement
// engine (Developer availability) and the Company doc (Admin enablement).
//
//   requireSheetAvailable        — Developer/Super-Admin made the feature
//                                  available to the company (ent.googleSheetIntegration).
//                                  Used to gate the ADMIN settings routes.
//   requireSheetEnabled([perm])  — available AND company-admin enabled, plus an
//                                  optional allow* sub-permission. Used to gate
//                                  the EMPLOYEE routes. Resolves + stamps the
//                                  tenant/employee context on the request.
// ─────────────────────────────────────────────────────────────────────────────

const Company = require("../models/Company");
const { getCompanyEntitlements } = require("../services/entitlementService");

// Resolve companyId across every auth context used in this codebase
// (mirrors entitlementMiddleware.resolveCompanyId).
function resolveCompanyId(req) {
  return (
    req.admin?.company?._id ||
    req.admin?.company      ||
    req.user?.company?._id  ||
    req.user?.company       ||
    req.companyId           ||
    null
  );
}

// Resolve the acting employee's id (employee token → req.user is the User doc).
function resolveEmployeeId(req) {
  return req.user?._id || req.user?.id || req.user?.userId || null;
}

const PERMISSION_FIELD = {
  connect:    "allowConnect",
  edit:       "allowEdit",
  disconnect: "allowDisconnect",
  sync:       "allowManualSync",
};

// ── Availability gate (admin settings) ───────────────────────────────────────
const requireSheetAvailable = () => async (req, res, next) => {
  try {
    // super_admin has unrestricted access (mirrors entitlementMiddleware.requireFeature)
    const role = req.admin?.role || req.user?.role || "";
    const isSuper =
      role === "super_admin" || role === "superadmin" || req.admin?.isSuperAdmin;

    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(401).json({
        success: false,
        message: "Company context not found",
        code:    "NO_COMPANY_CONTEXT",
      });
    }

    if (isSuper) {
      req.sheetCompanyId = companyId;
      return next();
    }

    const ent = await getCompanyEntitlements(companyId);
    if (!ent || !ent.googleSheetIntegration) {
      return res.status(403).json({
        success: false,
        message: "Excel / Google Sheet integration is not available for your company.",
        code:    "SHEET_FEATURE_NOT_AVAILABLE",
      });
    }

    req.sheetCompanyId = companyId;
    return next();
  } catch (err) {
    console.error("[requireSheetAvailable]", err.message);
    return res.status(500).json({ success: false, message: "Feature check failed" });
  }
};

// ── Enablement + permission gate (employee routes) ────────────────────────────
// @param {"connect"|"edit"|"disconnect"|"sync"} [permission] — optional sub-permission
const requireSheetEnabled = (permission = null) => async (req, res, next) => {
  try {
    const companyId  = resolveCompanyId(req);
    const employeeId = resolveEmployeeId(req);

    if (!companyId) {
      return res.status(401).json({
        success: false, message: "Company context not found", code: "NO_COMPANY_CONTEXT",
      });
    }
    if (!employeeId) {
      return res.status(401).json({
        success: false, message: "Employee context not found", code: "NO_EMPLOYEE_CONTEXT",
      });
    }

    // Layer 1 — Developer availability
    const ent = await getCompanyEntitlements(companyId);
    if (!ent || !ent.googleSheetIntegration) {
      return res.status(403).json({
        success: false,
        message: "Excel / Google Sheet integration is not available for your company.",
        code:    "SHEET_FEATURE_NOT_AVAILABLE",
      });
    }

    // Layer 2 — Company Admin enablement (+ sub-permissions)
    const company = await Company.findById(companyId)
      .select("employeeSheetIntegration")
      .lean();
    const cfg = company?.employeeSheetIntegration || {};

    if (!cfg.enabled) {
      return res.status(403).json({
        success: false,
        message: "Excel / Google Sheet integration is disabled by your company admin.",
        code:    "SHEET_FEATURE_DISABLED",
      });
    }

    if (permission) {
      const field = PERMISSION_FIELD[permission];
      // allow* fields default true; only an explicit false blocks.
      if (field && cfg[field] === false) {
        return res.status(403).json({
          success: false,
          message: `You are not permitted to ${permission} sheet connections. Contact your admin.`,
          code:    "SHEET_PERMISSION_DENIED",
          permission,
        });
      }
    }

    // Stamp resolved context for downstream controllers (company isolation).
    req.sheetCompanyId   = companyId;
    req.sheetEmployeeId  = employeeId;
    req.sheetPermissions = {
      allowConnect:    cfg.allowConnect    !== false,
      allowEdit:       cfg.allowEdit       !== false,
      allowDisconnect: cfg.allowDisconnect !== false,
      allowManualSync: cfg.allowManualSync !== false,
    };

    return next();
  } catch (err) {
    console.error("[requireSheetEnabled]", err.message);
    return res.status(500).json({ success: false, message: "Feature check failed" });
  }
};

module.exports = {
  requireSheetAvailable,
  requireSheetEnabled,
  resolveCompanyId,
  resolveEmployeeId,
};
