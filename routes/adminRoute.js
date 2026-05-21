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
  createCompanyUser,
  deleteCompanyUser,
  getDashboardStats,
  getAutoTemplateSettings,
  updateAutoTemplateSettings,
  getCompanyBrand,
  updateCompanyBrand,
  deleteCompanyLogo,
  getBrevoStatus,
  saveBrevoConfig,
  // ── New integration config handlers ──────────────────────────────────────
  getBrevoConfig,
  saveBrevoFullConfig,
  deleteBrevoConfig,
  getMsg91Config,
  saveMsg91Config,
  deleteMsg91Config,
} = adminController;
const {
  registerAdmin,
  loginAdmin,
  logoutAdmin,
} = require("../controllers/adminAuthController");
const { protectAdmin, requireCompanySuperAdmin } = require("../middlewares/adminAuthMiddleware");
const { authLimiter }  = require("../middlewares/rateLimiter");

// ── Auth (public) ─────────────────────────────────────────────────────────────
router.post("/register", authLimiter, registerAdmin);
router.post("/login",    authLimiter, loginAdmin);
router.post("/logout",   protectAdmin, logoutAdmin);

// ── Company-specific routes (must be before /:id to avoid conflict) ───────────
router.get("/company/me",        protectAdmin, getMyCompany || ((req, res) => res.status(501).json({ message: "Not implemented" })));
router.get("/company/users",     protectAdmin, getCompanyUsers);
router.get("/company/leads",     protectAdmin, getCompanyLeads);
router.get("/dashboard-stats",   protectAdmin, getDashboardStats);
router.get("/company/auto-template", protectAdmin, getAutoTemplateSettings);
router.put("/company/auto-template", protectAdmin, updateAutoTemplateSettings);

// ── Company Branding (SuperAdmin only) ────────────────────────────────────────
router.get("/company/brand",         protectAdmin, getCompanyBrand);
router.put("/company/brand",         protectAdmin, requireCompanySuperAdmin, updateCompanyBrand);
router.delete("/company/brand/logo", protectAdmin, requireCompanySuperAdmin, deleteCompanyLogo);

// ── Brevo email config (full: GET + PUT + DELETE) ─────────────────────────────
router.get("/company/brevo-config",    protectAdmin, getBrevoConfig);
router.put("/company/brevo-config",    protectAdmin, requireCompanySuperAdmin, saveBrevoFullConfig);
router.delete("/company/brevo-config", protectAdmin, requireCompanySuperAdmin, deleteBrevoConfig);

// ── MSG91 config — WhatsApp + SMS in one (GET + PUT + DELETE) ─────────────────
router.get("/company/msg91-config",    protectAdmin, getMsg91Config);
router.put("/company/msg91-config",    protectAdmin, requireCompanySuperAdmin, saveMsg91Config);
router.delete("/company/msg91-config", protectAdmin, requireCompanySuperAdmin, deleteMsg91Config);

// ── Legacy brevo-status (kept for backward compat) ───────────────────────────
router.get("/company/brevo-status",  protectAdmin, getBrevoStatus);

// ── Admin CRUD (protected) ────────────────────────────────────────────────────
router.get("/",  protectAdmin, getAdmins);
router.post("/", protectAdmin, requireCompanySuperAdmin, createAdmin);

// User create/delete — must be before /:id to avoid conflict
router.post("/user",       protectAdmin, createCompanyUser);
router.delete("/user/:id", protectAdmin, deleteCompanyUser);

router.get("/:id",    protectAdmin, getAdmin);
router.delete("/:id", protectAdmin, requireCompanySuperAdmin, deleteAdmin);
router.put("/:id",    protectAdmin, requireCompanySuperAdmin, updateAdmin);

module.exports = router;
