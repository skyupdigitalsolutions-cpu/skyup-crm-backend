// routes/superAdminRoute.js
const express = require("express");
const router = express.Router();
const {
  registerSuperAdmin,
  loginSuperAdmin,
  createCompany,
  createAdmin,
  getCompanies,
  getCompany,
  toggleCompany,
  deleteCompany,
  getDashboardStats,
  getAdminDetails,
  getAllAdminsWithStats,
} = require("../controllers/superAdminController");
const { protectUnified, authorizeRoles } = require("../middlewares/authMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");
const companyIsolation = require("../middlewares/companyIsolation");
const { authLimiter } = require("../middlewares/rateLimiter");

// ── Auth (public) ─────────────────────────────────────────────────────────────
router.post("/register", authLimiter, registerSuperAdmin); // Run once only!
router.post("/login",    authLimiter, loginSuperAdmin);     // Legacy — use /api/auth/login instead

// ── Protected routes — use new unified middleware stack ───────────────────────
router.get("/dashboard",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getDashboardStats);

// ── Admin management ──────────────────────────────────────────────────────────
router.post("/admins",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, createAdmin);

// NEW: list all admins with user/lead counts (for the filter dropdown)
router.get("/admins",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getAllAdminsWithStats);

// NEW: get full details for one specific admin (users, leads, phone reveals)
router.get("/admins/:adminId",
  protectUnified, authorizeRoles("super_admin"), companyIsolation, getAdminDetails);

// ── Legacy company management (kept for backward compat; developer does this now) ──
router.get("/companies",        protectSuperAdmin, getCompanies);
router.post("/companies",       protectSuperAdmin, createCompany);
router.get("/companies/:id",    protectSuperAdmin, getCompany);
router.put("/companies/:id",    protectSuperAdmin, toggleCompany);
router.delete("/companies/:id", protectSuperAdmin, deleteCompany);

module.exports = router;
