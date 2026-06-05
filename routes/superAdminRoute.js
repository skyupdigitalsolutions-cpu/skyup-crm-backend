// routes/superAdminRoute.js — UPDATED
// Added: GET /companies/:id/entitlements → superAdminController.getCompanyEntitlementDetails
// All existing routes are UNCHANGED.

const express = require("express");
const router  = express.Router();

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
  getCompanyEntitlementDetails,   // NEW
} = require("../controllers/superAdminController");

const { protectUnified, authorizeRoles } = require("../middlewares/authMiddleware");
const { protectSuperAdmin }              = require("../middlewares/superAdminMiddleware");
const companyIsolation                   = require("../middlewares/companyIsolation");
const { authLimiter }                    = require("../middlewares/rateLimiter");

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

// ── NEW: Entitlement details for a company (visible to super_admin) ───────────
router.get("/companies/:id/entitlements",
  protectSuperAdmin, getCompanyEntitlementDetails);

// ── Legacy company management ─────────────────────────────────────────────────
router.get("/companies",        protectSuperAdmin, getCompanies);
router.post("/companies",       protectSuperAdmin, createCompany);
router.get("/companies/:id",    protectSuperAdmin, getCompany);
router.put("/companies/:id",    protectSuperAdmin, toggleCompany);
router.delete("/companies/:id", protectSuperAdmin, deleteCompany);

module.exports = router;
