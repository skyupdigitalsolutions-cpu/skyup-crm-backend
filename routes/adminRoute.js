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
  getMarketingDashboard,
  getDistinctLeadLanguages,
  updateLeadLanguage,
  updateUserLanguages,
  createCompanyUser,
  deleteCompanyUser,
  resetAdminPassword,
  resetUserPassword,
  getDashboardStats,
  getAutoTemplateSettings,
  updateAutoTemplateSettings,
  getInterestedBlastSettings,
  updateInterestedBlastSettings,
  testAutoTemplate,
  testInterestedBlast,
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
const { validateObjectId } = require("../middlewares/validateObjectId");
const { protectAny } = require("../middlewares/authMiddleware");
const { authLimiter, ipFloodLimiter } = require("../middlewares/rateLimiter");
const { checkLimit }   = require("../middlewares/entitlementMiddleware");
const User             = require("../models/Users");
const Admin            = require("../models/Admin");

// ── Auth (public) ─────────────────────────────────────────────────────────────
router.post("/register", ipFloodLimiter, authLimiter, registerAdmin);
router.post("/login",    ipFloodLimiter, authLimiter, loginAdmin);
router.post("/logout",   protectAdmin, logoutAdmin);

// ── Device / FCM token registration (must be before /:id to avoid conflict) ──
router.patch("/update-device", protectAdmin, adminController.updateAdminDevice);

// ── Company-specific routes (must be before /:id to avoid conflict) ───────────
router.get("/company/me",        protectAdmin, getMyCompany || ((req, res) => res.status(501).json({ message: "Not implemented" })));
router.get("/company/users",     protectAdmin, getCompanyUsers);

// ── Per-employee device call-log sync permission ──────────────────────────────
// PUT /admin/company/users/:id/call-log-sync  body: { enabled: boolean }
// Super-admin (company owner) toggles whether THIS employee's phone may sync
// call logs. Scoped to the caller's company so an admin can't touch another
// company's users. The effective gate is company flag AND this per-user flag.
router.put(
  "/company/users/:id/call-log-sync",
  protectAdmin,
  requireCompanySuperAdmin,
  async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ success: false, message: "`enabled` must be a boolean." });
      }

      const companyId = req.admin?.company?._id || req.admin?.company || req.user?.companyId;
      if (!companyId) {
        return res.status(400).json({ success: false, message: "No company context." });
      }

      // Scope the lookup to the caller's company so cross-company edits are impossible.
      const user = await User.findOne({ _id: req.params.id, company: companyId });
      if (!user) {
        return res.status(404).json({ success: false, message: "Employee not found in your company." });
      }

      user.callLogSyncEnabled   = enabled;
      user.callLogSyncUpdatedBy = req.admin?._id || null;
      user.callLogSyncUpdatedAt = new Date();
      await user.save();

      return res.json({
        success: true,
        message: `Call log sync ${enabled ? "enabled" : "disabled"} for ${user.name}.`,
        userId: user._id,
        callLogSyncEnabled: user.callLogSyncEnabled,
      });
    } catch (err) {
      console.error("[call-log-sync per-user]", err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.get("/company/leads",     protectAdmin, getCompanyLeads);
router.get("/leads/languages",   protectAdmin, getDistinctLeadLanguages);
router.patch("/leads/:id/language", protectAdmin, validateObjectId("id"), updateLeadLanguage);
router.put("/users/:id/languages",  protectAdmin, validateObjectId("id"), updateUserLanguages);
router.get("/dashboard-stats",   protectAdmin, getDashboardStats);
router.get("/marketing-dashboard", protectAdmin, getMarketingDashboard);
router.get("/company/auto-template", protectAdmin, getAutoTemplateSettings);
router.put("/company/auto-template", protectAdmin, updateAutoTemplateSettings);
router.post("/company/auto-template/test", protectAdmin, testAutoTemplate);
router.get("/company/interested-blast", protectAdmin, getInterestedBlastSettings);
router.put("/company/interested-blast", protectAdmin, updateInterestedBlastSettings);
router.post("/company/interested-blast/test", protectAdmin, testInterestedBlast);

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
router.put("/user/:id/telegram", protectAdmin, validateObjectId("id"), updateUserTelegram);

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
router.put("/user/:id/meeting-permission", protectAdmin, validateObjectId("id"), updateMeetingPermission);

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
router.delete("/user/:id", protectAdmin, validateObjectId("id"), deleteCompanyUser);

// SECURITY FIX replacement feature — see controllers/adminController.js.
// Reset (not view) a password: generates a brand-new one, returned once.
router.patch("/:id/reset-password",      protectAdmin, validateObjectId("id"), requireCompanySuperAdmin, resetAdminPassword);
router.patch("/user/:id/reset-password", protectAdmin, validateObjectId("id"), resetUserPassword);

router.get("/:id",    protectAdmin, validateObjectId("id"), getAdmin);
router.delete("/:id", protectAdmin, validateObjectId("id"), requireCompanySuperAdmin, deleteAdmin);
router.put("/:id",    protectAdmin, validateObjectId("id"), requireCompanySuperAdmin, updateAdmin);

module.exports = router;
