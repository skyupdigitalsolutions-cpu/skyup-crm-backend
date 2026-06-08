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
  // getBrevoStatus,
  // saveBrevoConfig,
  // ── New integration config handlers ──────────────────────────────────────
  getBrevoConfig,
  saveBrevoFullConfig,
  deleteBrevoConfig,
  getMsg91Config,
  saveMsg91Config,
  deleteMsg91Config,
  getTelegramConfig,
  saveTelegramConfig,
  testTelegramConfig,
} = adminController;
const {
  registerAdmin,
  loginAdmin,
  logoutAdmin,
} = require("../controllers/adminAuthController");
const { protectAdmin, requireCompanySuperAdmin } = require("../middlewares/adminAuthMiddleware");
const { protectAny } = require("../middlewares/authMiddleware");
const { authLimiter }  = require("../middlewares/rateLimiter");
const { checkLimit }   = require("../middlewares/entitlementMiddleware");
const User             = require("../models/Users");
const Admin            = require("../models/Admin");

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

// ── Company Branding (SuperAdmin only to modify; any authenticated user can read) ──
router.get("/company/brand",         protectAdmin, getCompanyBrand);
router.get("/company/brand/public",  protectAny,   getCompanyBrand);   // accessible to employee (user) tokens
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

// ── Telegram notification config (campaign leads only) ────────────────────────
router.get("/company/telegram",       protectAdmin, getTelegramConfig);
router.put("/company/telegram",       protectAdmin, requireCompanySuperAdmin, saveTelegramConfig);
router.post("/company/telegram/test", protectAdmin, testTelegramConfig);

// ── Legacy brevo-status (kept for backward compat) ───────────────────────────
// router.get("/company/brevo-status",  protectAdmin, getBrevoStatus);

// ── Admin CRUD (protected) ────────────────────────────────────────────────────
router.get("/",  protectAdmin, getAdmins);
router.post(
  "/",
  protectAdmin,
  requireCompanySuperAdmin,
  checkLimit("admins", async (req) => {
    const companyId = req.admin?.company?._id || req.admin?.company;
    return Admin.countDocuments({ company: companyId, role: "admin" });
  }),
  createAdmin
);

// User create/delete — must be before /:id to avoid conflict
router.post(
  "/user",
  protectAdmin,
  checkLimit("users", async (req) => {
    const companyId = req.admin?.company?._id || req.admin?.company;
    return User.countDocuments({ company: companyId });
  }),
  createCompanyUser
);
router.delete("/user/:id", protectAdmin, deleteCompanyUser);

router.get("/:id",    protectAdmin, getAdmin);
router.delete("/:id", protectAdmin, requireCompanySuperAdmin, deleteAdmin);
router.put("/:id",    protectAdmin, requireCompanySuperAdmin, updateAdmin);

module.exports = router;
