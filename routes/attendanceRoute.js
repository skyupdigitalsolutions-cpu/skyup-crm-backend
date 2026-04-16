const express = require("express");
const router = express.Router();
const { clockIn, clockOut, startBreak, endBreak, pingActivity, getMyToday, getCompanyAttendance, markIdleUsers } = require("../controllers/attendanceController");
const { protect } = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// User routes
router.post("/clock-in",    protect, clockIn);
router.post("/clock-out",   protect, clockOut);
router.post("/break/start", protect, startBreak);
router.post("/break/end",   protect, endBreak);
router.post("/ping",        protect, pingActivity);
router.get("/my-today",     protect, getMyToday);

// Admin routes
router.get("/company",      protectAdmin, getCompanyAttendance);
router.post("/mark-idle",   protectAdmin, markIdleUsers);

module.exports = router;