// routes/sheetIntegration.js — NEW
// ─────────────────────────────────────────────────────────────────────────────
// Employee Excel / Google Sheet integration routes. COMPLETELY SEPARATE from
// Daily Report / Telegram / campaign routes.
//
// Two audiences on one router:
//   • ADMIN routes (/admin/*) — protectAdmin + requireSheetAvailable().
//       Manage the company-level enable/permissions (Section 9). Gated by the
//       Developer "availability" flag so the admin only sees them once the
//       feature is made available to their company.
//   • EMPLOYEE routes (/*)     — protect + requireSheetEnabled([permission]).
//       Every write validates: authenticated user + companyId + employeeId +
//       feature available + admin-enabled + sub-permission (Sections 2 & 8).
//
// /status is intentionally soft-gated (protect only) so the frontend can ask
// "should I even show this option?" and get a clean {available,enabled} answer
// instead of a 403.
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router  = express.Router();

const { protect }      = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const {
  requireSheetAvailable,
  requireSheetEnabled,
} = require("../middlewares/sheetIntegrationAccess");

const {
  // employee
  getStatus,
  getMyConnection,
  testConnection,
  saveConnection,
  saveMapping,
  syncNow,
  disconnect,
  // admin
  getAdminSettings,
  updateAdminSettings,
  adminListConnections,
} = require("../controllers/sheetIntegrationController");

// ── ADMIN (company control) ───────────────────────────────────────────────────
router.get("/admin/settings",     protectAdmin, requireSheetAvailable(), getAdminSettings);
router.put("/admin/settings",     protectAdmin, requireSheetAvailable(), updateAdminSettings);
router.get("/admin/connections",  protectAdmin, requireSheetAvailable(), adminListConnections);

// ── EMPLOYEE ──────────────────────────────────────────────────────────────────
// Soft status probe (no hard 403 — returns {available,enabled,permissions})
router.get("/status", protect, getStatus);

// Read own connection (must be enabled)
router.get("/me", protect, requireSheetEnabled(), getMyConnection);

// Test Connection — allowed for anyone who can connect OR edit
router.post("/test", protect, requireSheetEnabled(), testConnection);

// Connect (create) / Edit (update)
router.post("/connect",    protect, requireSheetEnabled("connect"), saveConnection);
router.put("/connection",  protect, requireSheetEnabled("edit"),    saveConnection);

// Column mapping
router.put("/mapping", protect, requireSheetEnabled("edit"), saveMapping);

// Sync Now
router.post("/sync", protect, requireSheetEnabled("sync"), syncNow);

// Disconnect
router.delete("/connection", protect, requireSheetEnabled("disconnect"), disconnect);

module.exports = router;
