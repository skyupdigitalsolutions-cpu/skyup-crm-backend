// routes/privacyRoute.js
const express = require("express");
const router  = express.Router();

const { protectAdmin }      = require("../middlewares/adminAuthMiddleware");
const { superAdminProtect } = require("../middlewares/superAdminMiddleware");

const {
  setupEncryption,
  verifyKey,
  getEncryptionStatus,
  disableEncryption,
  resetEncryption,
} = require("../controllers/privacyController");

// ── Admin routes — company admin manages their own encryption ─────────────────
// POST /api/privacy/setup   — send 12-word mnemonic to enable encryption
// POST /api/privacy/verify  — verify mnemonic matches stored hash (used on login)
// GET  /api/privacy/status  — get encryption + subscription status
router.post("/setup",  protectAdmin, setupEncryption);
router.post("/verify", protectAdmin, verifyKey);
router.get("/status",  protectAdmin, getEncryptionStatus);

// ── SuperAdmin only routes ────────────────────────────────────────────────────
// POST /api/privacy/disable/:companyId — emergency disable
// POST /api/privacy/reset              — set up new phrase after disable
router.post("/disable/:companyId", superAdminProtect, disableEncryption);
router.post("/reset",              superAdminProtect, resetEncryption);

module.exports = router;