// routes/adminRoute.js
const express = require("express");
const router  = express.Router();
const adminController = require("../controllers/adminController");
const {
  getMyCompany,
  getAdmin,
  getAdmins,
  createAdmin,
  deleteAdmin,
  updateAdmin,
  getCompanyUsers,
  getCompanyLeads,
  deleteCompanyUser,
  getDashboardStats,
} = adminController;
const {
  registerAdmin,
  loginAdmin,
  logoutAdmin,                                             // ✅ NEW
} = require("../controllers/adminAuthController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { authLimiter }  = require("../middlewares/rateLimiter");

// ── Auth (public) ─────────────────────────────────────────────────────────────
router.post("/register", authLimiter, registerAdmin);
router.post("/login",    authLimiter, loginAdmin);
router.post("/logout",   protectAdmin, logoutAdmin);       // ✅ NEW — blacklists JWT in Redis

// ── Company-specific routes (must be before /:id to avoid conflict) ───────────
router.get("/company/me",        protectAdmin, getMyCompany || ((req, res) => res.status(501).json({ message: "Not implemented" })));
router.get("/company/users",     protectAdmin, getCompanyUsers);
router.get("/company/leads",     protectAdmin, getCompanyLeads);
router.get("/dashboard-stats",   protectAdmin, getDashboardStats);

// ── Admin CRUD (protected) ────────────────────────────────────────────────────
router.get("/",  protectAdmin, getAdmins);
router.post("/", protectAdmin, createAdmin);

// User delete — must be before /:id to avoid conflict
router.delete("/user/:id", protectAdmin, deleteCompanyUser);

router.get("/:id",    protectAdmin, getAdmin);
router.delete("/:id", protectAdmin, deleteAdmin);
router.put("/:id",    protectAdmin, updateAdmin);

module.exports = router;