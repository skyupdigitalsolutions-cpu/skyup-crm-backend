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
const { authLimiter }                    = require("../middlewares/rateLimiter");

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
router.post("/register",   authLimiter, registerSuperAdmin);
router.post("/login",      authLimiter, loginSuperAdmin);
router.post("/verify-otp", authLimiter, verifySuperAdminOtp);
router.post("/resend-otp", authLimiter, resendSuperAdminOtp);

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
router.post("/marketing-users",             protectUnified, authorizeRoles("super_admin"), companyIsolation, createMarketingUser);
router.get("/marketing-users",              protectUnified, authorizeRoles("super_admin"), companyIsolation, listMarketingUsers);
router.patch("/marketing-users/:id/toggle", protectUnified, authorizeRoles("super_admin"), companyIsolation, toggleMarketingAccess);
router.delete("/marketing-users/:id",       protectUnified, authorizeRoles("super_admin"), companyIsolation, deleteMarketingUser);

module.exports = router;