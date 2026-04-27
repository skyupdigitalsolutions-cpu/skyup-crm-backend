// routes/privacyRoute.js
const express = require("express");
const router  = express.Router();

const { protectAdmin }      = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");

const {
  setupEncryption,
  verifyKey,
  getEncryptionStatus,
  disableEncryption,
  resetEncryption,
} = require("../controllers/privacyController");

// ── Admin routes — company admin manages their own encryption ─────────────────
// POST /api/privacy/setup   — generate 12-word mnemonic to enable encryption
// POST /api/privacy/verify  — verify mnemonic matches stored hash (used on login)
// GET  /api/privacy/status  — get encryption + subscription status
router.post("/setup",  protectAdmin, setupEncryption);
router.post("/verify", protectAdmin, verifyKey);
router.get("/status",  protectAdmin, getEncryptionStatus);

// ── SuperAdmin only routes ────────────────────────────────────────────────────
// POST /api/privacy/disable/:companyId — emergency disable encryption
// POST /api/privacy/reset              — generate new phrase after disable
router.post("/disable/:companyId", protectSuperAdmin, disableEncryption);
router.post("/reset",              protectSuperAdmin, resetEncryption);

module.exports = router;