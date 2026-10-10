// routes/superAdminRoute.js — UPDATED
// Added: GET /expiring-subscriptions → superAdminController.getExpiringSubscriptions
// Added: GET /companies/:id/entitlements → superAdminController.getCompanyEntitlementDetails
// All existing routes are UNCHANGED.

const express = require("express");
const { validateObjectId } = require("../middlewares/validateObjectId");
const router  = express.Router();

const {
  registerSuperAdmin,
  loginSuperAdmin,
  verifySuperAdminOtp,
  resendSuperAdminOtp,
  createCompany,
  createAdmin,
  createMarketingUser,
  listMarketingUsers,
  toggleMarketingAccess,
  deleteMarketingUser,
  getCompanies,
  getCompany,
  toggleCompany,
  toggleCallLogSync,
  deleteCompany,
  getDashboardStats,
  getAdminDetails,
  getAllAdminsWithStats,
  getCompanyEntitlementDetails,
  getExpiringSubscriptions,
} = require("../controllers/superAdminController");

const { protectUnified, authorizeRoles } = require("../middlewares/authMiddleware");
const { protectSuperAdmin }              = require("../middlewares/superAdminMiddleware");
const companyIsolation                   = require("../middlewares/companyIsolation");
const { authLimiter, ipFloodLimiter } = require("../middlewares/rateLimiter");

// Custom financial reports (per company, free-form fields, AI analysis).
const {
  createCustomReport,
  listCustomReports,
  getCustomReport,
  updateCustomReport,
  deleteCustomReport,
  getCustomReportTrends,
  getCustomReportLeadMetrics,
  analyzeCustomReport,
} = require("../controllers/customReportController");

// ── Auth (public) ─────────────────────────────────────────────────────────────
router.post("/register",   ipFloodLimiter, authLimiter, registerSuperAdmin);
router.post("/login",      ipFloodLimiter, authLimiter, loginSuperAdmin);
router.post("/verify-otp", ipFloodLimiter, authLimiter, verifySuperAdminOtp);
router.post("/resend-otp", ipFloodLimiter, authLimiter, resendSuperAdminOtp);

// ── Protected routes — unified middleware stack ───────────────────────────────
router.get("/dashboard",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getDashboardStats);

// ── Admin management ──────────────────────────────────────────────────────────
router.post("/admins",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, createAdmin);
router.get("/admins",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getAllAdminsWithStats);
router.get("/admins/:adminId",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getAdminDetails);

// ── Expiring subscriptions — pre-populates NotificationProvider bell ──────────
// Called on mount by super_admin role to show upcoming expiry alerts.
// Query param: ?days=N (default 30, max 90)
router.get("/expiring-subscriptions",
  protectSuperAdmin, getExpiringSubscriptions);

// ── Entitlement details for a company ────────────────────────────────────────
router.get("/companies/:id/entitlements",
  protectSuperAdmin, getCompanyEntitlementDetails);

// ── Company management ────────────────────────────────────────────────────────
router.get("/companies",        protectSuperAdmin, getCompanies);
router.post("/companies",       protectSuperAdmin, createCompany);
router.get("/companies/:id",    protectSuperAdmin, validateObjectId("id"), getCompany);
router.put("/companies/:id",    protectSuperAdmin, validateObjectId("id"), toggleCompany);
router.put("/companies/:id/call-log-sync", protectSuperAdmin, validateObjectId("id"), toggleCallLogSync);
router.delete("/companies/:id", protectSuperAdmin, validateObjectId("id"), deleteCompany);

// ── Custom financial reports ──────────────────────────────────────────────────
// Per-company, free-form fields, generic analytics + AI suggestions.
// NOTE: specific paths (/trends, /analyze) are declared with their :id segment;
// list/create on the collection root.
router.post   ("/custom-reports",            protectSuperAdmin, createCustomReport);
router.get    ("/custom-reports",            protectSuperAdmin, listCustomReports);
router.get    ("/custom-reports/:id/trends", protectSuperAdmin, getCustomReportTrends);
router.get    ("/custom-reports/:id/lead-metrics", protectSuperAdmin, getCustomReportLeadMetrics);
router.post   ("/custom-reports/:id/analyze",protectSuperAdmin, analyzeCustomReport);
router.get    ("/custom-reports/:id",        protectSuperAdmin, getCustomReport);
router.put    ("/custom-reports/:id",        protectSuperAdmin, updateCustomReport);
router.delete ("/custom-reports/:id",        protectSuperAdmin, deleteCustomReport);


// ── Marketing Panel credential management ─────────────────────────────────────
// Marketing-dashboard logins only for companies where it is enabled.
async function requireMarketingModule(req, res, next) {
  const { marketingEnabled } = require("../middlewares/marketingAuthMiddleware");
  const companyId = req.callerCompany || req.user?.company || req.admin?.company;
  if (await marketingEnabled(companyId)) return next();
  return res.status(403).json({ message: "Digital Marketing Dashboard is not enabled for your company." });
}

router.post("/marketing-users",             protectUnified, authorizeRoles("super_admin"), companyIsolation, requireMarketingModule, createMarketingUser);
router.get("/marketing-users",              protectUnified, authorizeRoles("super_admin"), companyIsolation, requireMarketingModule, listMarketingUsers);
router.patch("/marketing-users/:id/toggle", protectUnified, authorizeRoles("super_admin"), companyIsolation, requireMarketingModule, toggleMarketingAccess);
router.delete("/marketing-users/:id",       protectUnified, authorizeRoles("super_admin"), companyIsolation, requireMarketingModule, deleteMarketingUser);

// ── Finance Panel credential management ───────────────────────────────────────
// Finance-panel logins only for companies where the Developer enabled the module.
async function requireFinanceModule(req, res, next) {
  const { financeEnabled } = require("../middlewares/financeAuthMiddleware");
  const companyId = req.callerCompany || (req.user && req.user.company) || (req.admin && req.admin.company);
  if (await financeEnabled(companyId)) return next();
  return res.status(403).json({ message: "Finance Dashboard is not enabled for your company." });
}
const financeUsers = require("../controllers/financeUserController");
router.post  ("/finance-users",             protectUnified, authorizeRoles("super_admin"), companyIsolation, requireFinanceModule, financeUsers.createFinanceUser);
router.get   ("/finance-users",             protectUnified, authorizeRoles("super_admin"), companyIsolation, requireFinanceModule, financeUsers.listFinanceUsers);
router.patch ("/finance-users/:id/toggle",  protectUnified, authorizeRoles("super_admin"), companyIsolation, requireFinanceModule, financeUsers.toggleFinanceAccess);
router.patch ("/finance-users/:id/password", protectUnified, authorizeRoles("super_admin"), companyIsolation, requireFinanceModule, financeUsers.resetFinancePassword);
router.delete("/finance-users/:id",         protectUnified, authorizeRoles("super_admin"), companyIsolation, requireFinanceModule, financeUsers.deleteFinanceUser);

module.exports = router;
