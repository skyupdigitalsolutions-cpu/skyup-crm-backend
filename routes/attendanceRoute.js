// routes/attendanceRoute.js — UPDATED
// Added requireFeature("attendance") gate to all admin and user attendance routes.
// Ensures companies without attendance in their plan cannot access any attendance APIs.

const express = require("express");
const router  = express.Router();

const {
  clockIn, clockOut, startBreak, endBreak, pingActivity, getMyToday,
  getShiftConfig,
  saveIdleRemark,
  getCompanyAttendance, markIdleUsers,
  getAttendanceReport, editAttendance, deleteAttendance, exportAttendance,
  adminUpsertAttendance,
  getCompanyUsers,
  requestMeetingPermission,
  getMeetingPermissionStatus,
  locationPing,
  getLiveLocations,
  getMeetingTrackingConfig,
  getGeofenceConfig,
  saveMeetingTrackingConfig,
} = require("../controllers/attendanceController");

const { protect }      = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { requireFeature } = require("../middlewares/entitlementMiddleware");

// ── User routes ───────────────────────────────────────────────────────────────
router.post("/clock-in",    protect, requireFeature("attendance"), clockIn);
router.post("/clock-out",   protect, requireFeature("attendance"), clockOut);
router.post("/break/start", protect, requireFeature("attendance"), startBreak);
router.post("/break/end",   protect, requireFeature("attendance"), endBreak);
router.post("/ping",        protect, requireFeature("attendance"), pingActivity);
router.get("/my-today",     protect, requireFeature("attendance"), getMyToday);
// FIX: "Ideal Time" retired as a per-day, per-employee free-text field the
// employee typed in themselves — it drifted into meaning "what I actually
// worked" instead of a fixed shift window. Replaced with a read-only endpoint
// backed by the company-wide shift config the admin already sets on the
// Attendance Settings page (adminController.js get/saveAttendanceConfig) —
// employees can only read it now, not edit it. POST /ideal-time removed.
router.get("/shift-config", protect, requireFeature("attendance"), getShiftConfig);
router.post("/idle-remark", protect, requireFeature("attendance"), saveIdleRemark);

// ── Meeting permission request ────────────────────────────────────────────────
router.post("/request-meeting-permission", protect, requireFeature("attendance"), requestMeetingPermission);
router.get("/meeting-permission-status",   protect, requireFeature("attendance"), getMeetingPermissionStatus);
router.get("/meeting-tracking-config",     protect, requireFeature("attendance"), getMeetingTrackingConfig);
router.get("/geofence-config",             protect, requireFeature("attendance"), getGeofenceConfig);

// ── Live location ping (employee → server, requires meeting permission) ───────
router.post("/location-ping", protect, requireFeature("attendance"), locationPing);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get("/company",      protectAdmin, requireFeature("attendance"), getCompanyAttendance);
router.post("/mark-idle",   protectAdmin, requireFeature("attendance"), markIdleUsers);
router.get("/live-locations", protectAdmin, requireFeature("attendance"), getLiveLocations);
router.get("/meeting-tracking",  protectAdmin, getMeetingTrackingConfig);
router.put("/meeting-tracking",  protectAdmin, saveMeetingTrackingConfig);

router.get("/report",       protectAdmin, requireFeature("attendance"), getAttendanceReport);
router.get("/export",       protectAdmin, requireFeature("attendance"), exportAttendance);
router.get("/users",        protectAdmin, requireFeature("attendance"), getCompanyUsers);
router.post("/admin-upsert", protectAdmin, requireFeature("attendance"), adminUpsertAttendance);
router.put("/:id",          protectAdmin, requireFeature("attendance"), editAttendance);
router.delete("/:id",       protectAdmin, requireFeature("attendance"), deleteAttendance);

module.exports = router;
