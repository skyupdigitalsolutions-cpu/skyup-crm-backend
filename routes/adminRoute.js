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
  getInterestedBlastSettings,
  updateInterestedBlastSettings,
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
  getMsg91EmailConfig,
  saveMsg91EmailConfig,
  deleteMsg91EmailConfig,
  getTelegramConfig,
  saveTelegramConfig,
  testTelegramConfig,
  getAdminsTelegramConfig,
  saveAdminTelegramConfig,
  testAdminTelegramConfig,
  updateUserTelegram,
  getClockInLocation,
  saveClockInLocation,
  updateMeetingPermission,
  registerMsg91Webhook,
  getLateLoginConfig,
  saveLateLoginConfig,
  getAttendanceConfig,
  saveAttendanceConfig,
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
router.get("/company/interested-blast", protectAdmin, getInterestedBlastSettings);
router.put("/company/interested-blast", protectAdmin, updateInterestedBlastSettings);

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
router.post("/company/msg91-register-webhook", protectAdmin, requireCompanySuperAdmin, registerMsg91Webhook);

// ── MSG91 Email config — primary email blast provider (GET + PUT + DELETE) ────
router.get("/company/msg91-email-config",    protectAdmin, getMsg91EmailConfig);
router.put("/company/msg91-email-config",    protectAdmin, requireCompanySuperAdmin, saveMsg91EmailConfig);
router.delete("/company/msg91-email-config", protectAdmin, requireCompanySuperAdmin, deleteMsg91EmailConfig);

// ── Telegram notification config (campaign leads only) ────────────────────────
router.get("/company/telegram",       protectAdmin, getTelegramConfig);
router.put("/company/telegram",       protectAdmin, requireCompanySuperAdmin, saveTelegramConfig);
router.post("/company/telegram/test", protectAdmin, testTelegramConfig);

// ── Per-admin Telegram config (super-admin manages each admin's personal chat) ─
router.get("/company/telegram/admins",                    protectAdmin, requireCompanySuperAdmin, getAdminsTelegramConfig);
router.put("/company/telegram/admins/:adminId",           protectAdmin, requireCompanySuperAdmin, saveAdminTelegramConfig);
router.post("/company/telegram/admins/:adminId/test",     protectAdmin, requireCompanySuperAdmin, testAdminTelegramConfig);

// ── Employee personal Telegram chat ID (admin sets for any employee) ──────────
router.put("/user/:id/telegram", protectAdmin, updateUserTelegram);

// ── Clock-in location restriction settings ────────────────────────────────────
router.get("/company/clock-in-location", protectAdmin, getClockInLocation);
router.put("/company/clock-in-location", protectAdmin, requireCompanySuperAdmin, saveClockInLocation);

// ── Late login threshold (admin sets what time counts as "Late") ──────────────
router.get("/company/late-login-config", protectAdmin, getLateLoginConfig);
router.put("/company/late-login-config", protectAdmin, requireCompanySuperAdmin, saveLateLoginConfig);

// ── Full company-wide attendance config (shift, holidays, weekly off) ─────────
router.get("/company/attendance-config", protectAdmin, getAttendanceConfig);
router.put("/company/attendance-config", protectAdmin, requireCompanySuperAdmin, saveAttendanceConfig);

// ── Client meeting remote clock-in permission (per employee) ──────────────────
router.put("/user/:id/meeting-permission", protectAdmin, updateMeetingPermission);

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