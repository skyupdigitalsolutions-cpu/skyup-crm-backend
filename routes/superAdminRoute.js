// routes/superAdminRoute.js
const express = require("express");
const router = express.Router();
const {
  registerSuperAdmin,
  loginSuperAdmin,
  verifySuperAdminOtp,
  resendSuperAdminOtp,
  createCompany,
  createAdmin,
  getCompanies,
  getCompany,
  toggleCompany,
  deleteCompany,
  getDashboardStats,
  getAdminDetails,
  getAllAdminsWithStats,
  getExpiringSubscriptions,
} = require("../controllers/superAdminController");
const { protectUnified, authorizeRoles } = require("../middlewares/authMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");
const companyIsolation = require("../middlewares/companyIsolation");
const { authLimiter } = require("../middlewares/rateLimiter");

// ── Auth (public) ─────────────────────────────────────────────────────────────
router.post("/register",   authLimiter, registerSuperAdmin);  // Run once only!
router.post("/login",      authLimiter, loginSuperAdmin);     // Step 1: sends OTP
router.post("/verify-otp", authLimiter, verifySuperAdminOtp); // Step 2: returns JWT
router.post("/resend-otp", authLimiter, resendSuperAdminOtp); // Resend OTP

// ── Protected routes — use new unified middleware stack ───────────────────────
router.get("/dashboard",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getDashboardStats);

// ── Admin management ──────────────────────────────────────────────────────────
router.post("/admins",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, createAdmin);

// list all admins with user/lead counts (for the filter dropdown)
router.get("/admins",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getAllAdminsWithStats);

// get full details for one specific admin (users, leads, phone reveals)
router.get("/admins/:adminId",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getAdminDetails);

// ── Legacy company management (kept for backward compat; developer does this now) ──
router.get("/companies",        protectSuperAdmin, getCompanies);
router.post("/companies",       protectSuperAdmin, createCompany);
router.get("/companies/:id",    protectSuperAdmin, getCompany);
router.put("/companies/:id",    protectSuperAdmin, toggleCompany);
router.delete("/companies/:id", protectSuperAdmin, deleteCompany);

// ── Subscription expiry monitoring ───────────────────────────────────────────
// Returns companies expiring within the next N days (default 30).
// Used by the frontend NotificationBell for in-app expiry alerts.
router.get("/expiring-subscriptions",
  protectSuperAdmin, getExpiringSubscriptions);

module.exports = router;