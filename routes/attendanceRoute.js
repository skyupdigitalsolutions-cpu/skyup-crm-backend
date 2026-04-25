const express = require("express");
const router  = express.Router();

const {
  clockIn, clockOut, startBreak, endBreak, pingActivity, getMyToday,
  getCompanyAttendance, markIdleUsers,
  getAttendanceReport, editAttendance, deleteAttendance, exportAttendance,
  getCompanyUsers,
} = require("../controllers/attendanceController");

const { protect }      = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// ── User routes ───────────────────────────────────────────────────────────────
router.post("/clock-in",    protect, clockIn);
router.post("/clock-out",   protect, clockOut);
router.post("/break/start", protect, startBreak);
router.post("/break/end",   protect, endBreak);
router.post("/ping",        protect, pingActivity);
router.get("/my-today",     protect, getMyToday);

// ── Admin routes — Live dashboard ─────────────────────────────────────────────
router.get("/company",      protectAdmin, getCompanyAttendance);
router.post("/mark-idle",   protectAdmin, markIdleUsers);

// ── Admin routes — Attendance Management ─────────────────────────────────────
router.get("/report",       protectAdmin, getAttendanceReport);   // date-range + filters
router.get("/export",       protectAdmin, exportAttendance);      // export JSON for xlsx
router.get("/users",        protectAdmin, getCompanyUsers);       // employee dropdown
router.put("/:id",          protectAdmin, editAttendance);        // edit a record
router.delete("/:id",       protectAdmin, deleteAttendance);      // delete a record

module.exports = router;