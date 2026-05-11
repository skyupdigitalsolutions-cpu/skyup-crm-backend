// routes/authRoutes.js
const express = require("express");
const router  = express.Router();
const { register, login, logout, updateDevice } = require("../controllers/authController");
const { authLimiter }  = require("../middlewares/rateLimiter");
const { protect }      = require("../middlewares/authMiddleware");

router.post("/register",      authLimiter, register);
router.post("/login",         authLimiter, login);
router.post("/logout",        protect,     logout);        // ✅ NEW — blacklists the JWT in Redis
router.patch("/update-device", protect,   updateDevice);  // mobile device info update

module.exports = router;