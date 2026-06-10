// routes/authRoutes.js — UPDATED (added /login unified endpoint + forgot-password OTP flow)
const express = require("express");
const router  = express.Router();
const { register, login, loginUnified, logout, updateDevice, updateMyTelegram } = require("../controllers/authController");
const { requestOtp, verifyOtpAndReset } = require("../controllers/forgotPasswordController");
const { authLimiter }  = require("../middlewares/rateLimiter");
const { protect }      = require("../middlewares/authMiddleware");

// ── Unified login — resolves Developer / Admin / super_admin / Employee ────────
router.post("/login",          authLimiter, loginUnified);

// ── Forgot-password OTP flow (public) ─────────────────────────────────────────
router.post("/forgot-password/request", authLimiter, requestOtp);
router.post("/forgot-password/reset",   authLimiter, verifyOtpAndReset);

// ── Legacy role-specific endpoints (kept for backward compat) ─────────────────
router.post("/register",       authLimiter, register);
router.post("/user-login",     authLimiter, login);        // employee-only login
router.post("/logout",         protect,     logout);        // blacklists the JWT in Redis
router.patch("/update-device", protect,     updateDevice);  // mobile device info update

// ── Employee self-service: update own Telegram chat ID ───────────────────────
router.patch("/my-telegram",   protect,     updateMyTelegram);

module.exports = router;