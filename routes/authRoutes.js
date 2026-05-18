// routes/authRoutes.js — UPDATED (added /login unified endpoint)
const express = require("express");
const router  = express.Router();
const { register, login, loginUnified, logout, updateDevice } = require("../controllers/authController");
const { authLimiter }  = require("../middlewares/rateLimiter");
const { protect }      = require("../middlewares/authMiddleware");

// ── Unified login — resolves Developer / Admin / super_admin / Employee ────────
router.post("/login",          authLimiter, loginUnified);

// ── Legacy role-specific endpoints (kept for backward compat) ─────────────────
router.post("/register",       authLimiter, register);
router.post("/user-login",     authLimiter, login);        // employee-only login
router.post("/logout",         protect,     logout);        // blacklists the JWT in Redis
router.patch("/update-device", protect,     updateDevice);  // mobile device info update

module.exports = router;