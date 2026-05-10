// routes/authRoutes.js
const express = require("express");
const router = express.Router();
const { register, login, updateDevice } = require("../controllers/authController");
const { authLimiter } = require("../middlewares/rateLimiter");
const { protect } = require("../middlewares/authMiddleware");

router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
// ✅ FIX: dedicated endpoint for mobile to PATCH device/IP info after login
//         replaces the old pattern of calling POST /auth/login a 2nd time
router.patch("/update-device", protect, updateDevice);

module.exports = router;