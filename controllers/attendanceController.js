const Attendance = require("../models/Attendance");
const User       = require("../models/Users");

// ── Socket helper — emits attendance:updated to the user's private room ───────
// The room name is `att:<userId>`. Both web and mobile join this room on mount.
// If io isn't set yet (e.g. tests), the emit is silently skipped.
function emitAttendanceUpdate(req, record) {
  try {
    const io = req.app.get("io") || global._io;
    if (!io) return;
    const userId = String(req.user._id);
    io.to(`att:${userId}`).emit("attendance:updated", record);
  } catch (e) {
    // Never let a socket error crash the HTTP response
    console.error("[socket] emitAttendanceUpdate error:", e.message);
  }
}

// Helpers
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function calcBreakMinutes(breaks) {
  return breaks.reduce((sum, b) => {
    if (b.startTime && b.endTime)
      return sum + Math.round((new Date(b.endTime) - new Date(b.startTime)) / 60000);
    return sum;
  }, 0);
}

/** Determine CRM attendance status from a raw record.*  Present / Late / Half-day / Absent / Leave  */
function deriveCrmStatus(rec) {
  if (!rec || !rec.loginTime) return "absent";
  const loginHour   = new Date(rec.loginTime).getHours();
  const loginMin    = new Date(rec.loginTime).getMinutes();
  const totalMinutes = loginHour * 60 + loginMin;
  const workMins    = rec.totalWorkMinutes || 0;

  if (rec.crmStatus) return rec.crmStatus; // manual override wins

  // Late threshold: 9:30 AM = 570 minutes
  if (totalMinutes > 570) return "late";
  if (workMins > 0 && workMins < 240) return "half_day";
  return "present";
}

// ── Haversine distance (metres) between two lat/lng points ───────────────────
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R    = 6_371_000; // Earth radius in metres
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── USER: Clock In ────────────────────────────────────────────────────────────
const DEVICE_FIELDS_ATT = ["appName", "appVersion", "platform", "deviceModel", "osVersion", "fcmToken"];

const clockIn = async (req, res) => {
  try {
    const userId    = req.user._id;
    const companyId = req.user.company;
    const date      = todayStr();

    // ── Location enforcement ─────────────────────────────────────────────────
    const Company = require('../models/Company');
    const company = await Company.findById(companyId)
      .select('clockInLocationEnabled clockInLatitude clockInLongitude clockInRadiusMeters')
      .lean();

    if (company?.clockInLocationEnabled && company.clockInLatitude && company.clockInLongitude) {
      // Check if employee has client-meeting permission (bypasses location check)
      const userDoc = await User.findById(userId)
        .select('clientMeetingPermission clientMeetingPermissionGrantedAt')
        .lean();

      const hasMeetingPermission = (() => {
        if (!userDoc?.clientMeetingPermission) return false;
        // Permission auto-expires after 24 hours
        if (!userDoc.clientMeetingPermissionGrantedAt) return false;
        const grantedAt = new Date(userDoc.clientMeetingPermissionGrantedAt);
        return (Date.now() - grantedAt.getTime()) < 24 * 60 * 60 * 1000;
      })();

      if (!hasMeetingPermission) {
        // Require device location from request body
        const { latitude, longitude } = req.body;
        if (latitude == null || longitude == null) {
          return res.status(400).json({
            message: 'Location required. Please enable location and try again.',
            code: 'location_required',
          });
        }

        const dist = haversineMetres(
          Number(latitude), Number(longitude),
          company.clockInLatitude, company.clockInLongitude,
        );

        if (dist > (company.clockInRadiusMeters || 100)) {
          return res.status(403).json({
            message: `You are ${Math.round(dist)}m from the office. Clock-in is only allowed within ${company.clockInRadiusMeters || 100}m. If you are at a client meeting, request remote clock-in permission from your admin.`,
            code:          'outside_radius',
            distanceMetres: Math.round(dist),
            radiusMetres:   company.clockInRadiusMeters || 100,
          });
        }
      }
    }

    // ── Pull device / app info if the mobile app sent it ──────────────────────
    const deviceFields = {};
    DEVICE_FIELDS_ATT.forEach(f => {
      if (req.body[f] !== undefined && req.body[f] !== null) {
        deviceFields[f] = req.body[f];
      }
    });

    // Store clock-in coordinates for audit
    if (req.body.latitude != null) deviceFields.clockInLatitude  = Number(req.body.latitude);
    if (req.body.longitude != null) deviceFields.clockInLongitude = Number(req.body.longitude);

    let record = await Attendance.findOne({ user: userId, date });
    if (record && record.loginTime && !record.logoutTime)
      return res.status(400).json({ message: "Already clocked in." });

    if (record) {
      record.loginTime        = new Date();
      record.logoutTime       = null;
      record.status           = "active";
      record.breaks           = [];
      record.totalBreakMinutes = 0;
      record.totalWorkMinutes  = 0;
      record.lastActivity     = new Date();
      record.activeBreakIndex = null;
      record.crmStatus        = null; // reset manual override
      // Refresh device fields on re-clock-in
      Object.assign(record, deviceFields);
      await record.save();
    } else {
      record = await Attendance.create({
        user: userId, company: companyId, date,
        loginTime: new Date(), status: "active", lastActivity: new Date(),
        ...deviceFields,
      });
    }

    // Keep User document current (in case login missed it)
    if (Object.keys(deviceFields).length > 0) {
      await User.findByIdAndUpdate(userId, { $set: deviceFields });
    }

    emitAttendanceUpdate(req, record);
    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: Clock Out ───────────────────────────────────────────────────────────
const clockOut = async (req, res) => {
  try {
    const date   = todayStr();
    const record = await Attendance.findOne({ user: req.user._id, date });
    if (!record || !record.loginTime)
      return res.status(400).json({ message: "Not clocked in." });

    // Close any open break
    if (record.activeBreakIndex !== null) {
      const br = record.breaks[record.activeBreakIndex];
      if (br && !br.endTime) {
        br.endTime         = new Date();
        br.durationMinutes = Math.round((br.endTime - br.startTime) / 60000);
      }
    }

    record.logoutTime         = new Date();
    record.status             = "logged_out";
    record.totalBreakMinutes  = calcBreakMinutes(record.breaks);
    const elapsed             = Math.round((record.logoutTime - record.loginTime) / 60000);
    record.totalWorkMinutes   = Math.max(0, elapsed - record.totalBreakMinutes);
    record.activeBreakIndex   = null;
    await record.save();

    emitAttendanceUpdate(req, record);
    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: Start Break ─────────────────────────────────────────────────────────
const startBreak = async (req, res) => {
  try {
    const { reason = "Manual Break" } = req.body;
    const date   = todayStr();
    const record = await Attendance.findOne({ user: req.user._id, date });
    if (!record || !record.loginTime || record.logoutTime)
      return res.status(400).json({ message: "Not clocked in." });
    if (record.activeBreakIndex !== null)
      return res.status(400).json({ message: "Already on break." });

    record.breaks.push({ startTime: new Date(), reason });
    record.activeBreakIndex = record.breaks.length - 1;
    record.status = reason === "Auto Idle" ? "idle" : "on_break";
    await record.save();
    emitAttendanceUpdate(req, record);
    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: End Break ───────────────────────────────────────────────────────────
const endBreak = async (req, res) => {
  try {
    const date   = todayStr();
    const record = await Attendance.findOne({ user: req.user._id, date });
    if (!record || record.activeBreakIndex === null)
      return res.status(400).json({ message: "Not on break." });

    const br           = record.breaks[record.activeBreakIndex];
    br.endTime         = new Date();
    br.durationMinutes = Math.round((br.endTime - br.startTime) / 60000);
    record.totalBreakMinutes = calcBreakMinutes(record.breaks);
    record.activeBreakIndex  = null;
    record.status            = "active";
    record.lastActivity      = new Date();
    await record.save();
    emitAttendanceUpdate(req, record);
    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: Ping Activity ───────────────────────────────────────────────────────
const pingActivity = async (req, res) => {
  try {
    const date   = todayStr();
    const record = await Attendance.findOne({ user: req.user._id, date });
    if (!record || !record.loginTime || record.logoutTime)
      return res.status(200).json({ ok: true });

    record.lastActivity = new Date();
    if (record.status === "idle") {
      if (record.activeBreakIndex !== null) {
        const br = record.breaks[record.activeBreakIndex];
        if (br && !br.endTime) {
          br.endTime         = new Date();
          br.durationMinutes = Math.round((br.endTime - br.startTime) / 60000);
        }
      }
      record.activeBreakIndex  = null;
      record.status            = "active";
      record.totalBreakMinutes = calcBreakMinutes(record.breaks);
    }
    await record.save();
    res.status(200).json({ ok: true, status: record.status });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: Get today's record ──────────────────────────────────────────────────
const getMyToday = async (req, res) => {
  try {
    const record = await Attendance.findOne({ user: req.user._id, date: todayStr() });
    if (!record) return res.status(200).json(null);
    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ADMIN: Mark idle users ────────────────────────────────────────────────────
const markIdleUsers = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const date      = todayStr();
    const cutoff    = new Date(Date.now() - 5 * 60 * 1000);

    const active = await Attendance.find({
      company: companyId, date, status: "active",
      lastActivity: { $lt: cutoff },
    });

    let marked = 0;
    for (const rec of active) {
      rec.breaks.push({ startTime: new Date(), reason: "Auto Idle" });
      rec.activeBreakIndex = rec.breaks.length - 1;
      rec.status = "idle";
      await rec.save();
      marked++;
    }
    res.status(200).json({ marked });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ADMIN: Get company attendance for a single date (live dashboard) ──────────
const getCompanyAttendance = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const { date = todayStr() } = req.query;

    // Scope: super_admin sees all users; regular admin sees only users they created
    const userQuery = { company: companyId };
    if (req.admin.role !== "super_admin") {
      userQuery.createdBy = req.admin._id;
    }

    const users   = await User.find(userQuery).select("name email ipAddress appName appVersion platform deviceModel osVersion lastLoginAt loginHistory").lean();
    const userIds = users.map(u => u._id);

    const records = await Attendance.find({ company: companyId, date, user: { $in: userIds } })
      .populate("user", "name email ipAddress appName appVersion platform deviceModel osVersion lastLoginAt loginHistory").lean();

    const recordMap = {};
    records.forEach(r => { recordMap[String(r.user?._id || r.user)] = r; });

    const now = new Date();
    const result = users.map(u => {
      const rec = recordMap[String(u._id)];
      if (!rec) {
        return { user: u, date, status: "not_logged_in", loginTime: null, logoutTime: null, totalWorkMinutes: 0, totalBreakMinutes: 0, breaks: [] };
      }
      let liveWork = rec.totalWorkMinutes;
      if (rec.loginTime && !rec.logoutTime) {
        const breakMins = rec.totalBreakMinutes + (rec.activeBreakIndex !== null
          ? Math.round((now - new Date(rec.breaks[rec.activeBreakIndex]?.startTime || now)) / 60000) : 0);
        liveWork = Math.max(0, Math.round((now - new Date(rec.loginTime)) / 60000) - breakMins);
      }
      let status = rec.status;
      if (status === "active" && rec.lastActivity && (now - new Date(rec.lastActivity)) > 5 * 60 * 1000) {
        status = "idle";
      }
      return { ...rec, user: u, status, liveWorkMinutes: liveWork };
    });

    res.status(200).json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ADMIN: Get attendance with date range + filters (Attendance Management page) ─
const getAttendanceReport = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const {
      startDate,
      endDate,
      userId,
      crmStatus,   // present | absent | late | half_day | leave
      page  = 1,
      limit = 50,
    } = req.query;

    const today = todayStr();
    const from  = startDate || today;
    const to    = endDate   || today;

    // Scope: super_admin sees all users; regular admin sees only their users
    let allowedUserIds = null;
    if (req.admin.role !== "super_admin") {
      const scopedUsers = await User.find({ company: companyId, createdBy: req.admin._id }).select("_id").lean();
      allowedUserIds = scopedUsers.map(u => u._id);
    }

    // Build base query
    const query = { company: companyId, date: { $gte: from, $lte: to } };
    if (userId) {
      // If a specific userId is requested, honour it only if it's in the allowed set
      if (allowedUserIds && !allowedUserIds.some(id => String(id) === String(userId))) {
        return res.status(200).json({ records: [], total: 0, page: 1, pages: 1 });
      }
      query.user = userId;
    } else if (allowedUserIds) {
      query.user = { $in: allowedUserIds };
    }

    // Fetch records
    const [records, total] = await Promise.all([
      Attendance.find(query)
        .populate("user", "name email ipAddress appName appVersion platform deviceModel osVersion lastLoginAt loginHistory")
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      Attendance.countDocuments(query),
    ]);

    // Enrich each record with CRM status
    const enriched = records.map(rec => ({
      ...rec,
      derivedCrmStatus : deriveCrmStatus(rec),
      workingHours     : formatWorkHours(rec.totalWorkMinutes),
    }));

    // Filter by crmStatus after derivation (can't do in DB query for derived field)
    const filtered = crmStatus
      ? enriched.filter(r => r.derivedCrmStatus === crmStatus)
      : enriched;

    // Get users for absent rows — scoped the same way as the main query
    const absentUserQuery = { company: companyId };
    if (allowedUserIds) absentUserQuery._id = { $in: allowedUserIds };
    const allUsers = await User.find(absentUserQuery).select("name email ipAddress").lean();

    // Build absent rows: users with no record in range who have no record for today
    let absentRows = [];
    if (!userId && (!crmStatus || crmStatus === "absent")) {
      const recordedUserIds = new Set(records.map(r => String(r.user?._id || r.user)));
      // For single-day requests, mark users with no record as absent
      if (from === to) {
        absentRows = allUsers
          .filter(u => !recordedUserIds.has(String(u._id)))
          .map(u => ({
            _id: null, user: u, date: from,
            loginTime: null, logoutTime: null,
            totalWorkMinutes: 0, totalBreakMinutes: 0,
            status: "not_logged_in", derivedCrmStatus: "absent",
            workingHours: "0h 00m", breaks: [], remarks: "",
          }));
      }
    }

    res.status(200).json({
      records : [...filtered, ...absentRows],
      total   : total + absentRows.length,
      page    : Number(page),
      pages   : Math.ceil((total + absentRows.length) / limit),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ADMIN: Edit attendance record ─────────────────────────────────────────────
const editAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { loginTime, logoutTime, crmStatus, remarks } = req.body;

    const record = await Attendance.findById(id);
    if (!record) return res.status(404).json({ message: "Record not found." });

    // Verify it belongs to this company
    if (String(record.company) !== String(req.admin.company._id))
      return res.status(403).json({ message: "Forbidden." });

    if (loginTime  !== undefined) record.loginTime  = loginTime  ? new Date(loginTime)  : null;
    if (logoutTime !== undefined) record.logoutTime = logoutTime ? new Date(logoutTime) : null;
    if (crmStatus  !== undefined) record.crmStatus  = crmStatus;
    if (remarks    !== undefined) record.remarks    = remarks;

    // Recalculate work minutes if both times are present
    if (record.loginTime && record.logoutTime) {
      const elapsed             = Math.round((record.logoutTime - record.loginTime) / 60000);
      record.totalBreakMinutes  = calcBreakMinutes(record.breaks);
      record.totalWorkMinutes   = Math.max(0, elapsed - record.totalBreakMinutes);
      if (record.status !== "logged_out") record.status = "logged_out";
    }

    await record.save();
    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ADMIN: Delete attendance record ──────────────────────────────────────────
const deleteAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await Attendance.findById(id);
    if (!record) return res.status(404).json({ message: "Record not found." });

    if (String(record.company) !== String(req.admin.company._id))
      return res.status(403).json({ message: "Forbidden." });

    await record.deleteOne();
    res.status(200).json({ message: "Deleted." });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ADMIN: Export attendance data (returns JSON — frontend builds xlsx) ────────
const exportAttendance = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const { startDate, endDate, userId, crmStatus } = req.query;

    const today = todayStr();
    const from  = startDate || today;
    const to    = endDate   || today;

    // Scope: super_admin sees all; regular admin sees only their users
    let exportAllowedIds = null;
    if (req.admin.role !== "super_admin") {
      const scopedUsers = await User.find({ company: companyId, createdBy: req.admin._id }).select("_id").lean();
      exportAllowedIds = scopedUsers.map(u => u._id);
    }

    const query = { company: companyId, date: { $gte: from, $lte: to } };
    if (userId) {
      if (exportAllowedIds && !exportAllowedIds.some(id => String(id) === String(userId))) {
        return res.status(200).json([]);
      }
      query.user = userId;
    } else if (exportAllowedIds) {
      query.user = { $in: exportAllowedIds };
    }

    const records = await Attendance.find(query)
      .populate("user", "name email ipAddress")
      .sort({ date: -1 })
      .lean();

    let enriched = records.map(rec => ({
      employeeName : rec.user?.name || "Unknown",
      email        : rec.user?.email || "",
      date         : rec.date,
      checkIn      : rec.loginTime  ? new Date(rec.loginTime).toLocaleTimeString("en-IN",  { hour: "2-digit", minute: "2-digit" }) : "—",
      checkOut     : rec.logoutTime ? new Date(rec.logoutTime).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—",
      workingHours : formatWorkHours(rec.totalWorkMinutes),
      breakMinutes : rec.totalBreakMinutes || 0,
      status       : deriveCrmStatus(rec),
      remarks      : rec.remarks || "",
    }));

    if (crmStatus) enriched = enriched.filter(r => r.status === crmStatus);

    res.status(200).json(enriched);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ADMIN: Get company users list (for employee filter dropdown) ───────────────
const getCompanyUsers = async (req, res) => {
  try {
    // Scope: super_admin sees all users; regular admin sees only their own users
    const userQuery = { company: req.admin.company._id };
    if (req.admin.role !== "super_admin") {
      userQuery.createdBy = req.admin._id;
    }
    const users = await User.find(userQuery)
      .select("name email ipAddress appName appVersion platform deviceModel osVersion lastLoginAt loginHistory createdAt").lean();
    res.status(200).json(users);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// Helper
function formatWorkHours(mins) {
  if (!mins) return "0h 00m";
  return `${Math.floor(mins / 60)}h ${(mins % 60).toString().padStart(2, "0")}m`;
}

// ── POST /attendance/request-meeting-permission ───────────────────────────────
// Employee requests remote clock-in (client meeting).
// Stores the request on the User document and emits a socket event to the admin.
const requestMeetingPermission = async (req, res) => {
  try {
    const userId    = req.user._id;
    const companyId = req.user.company;
    const { reason, location } = req.body;

    // Store the pending request on the user document
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          meetingPermissionRequested:   true,
          meetingPermissionRequestedAt: new Date(),
          meetingPermissionReason:      (reason || '').trim(),
          meetingPermissionLocation:    (location || '').trim(),
          meetingPermissionStatus:      'pending',
        },
      },
      { new: true }
    ).select('name email clientMeetingPermission meetingPermissionStatus createdBy');

    // Emit socket notification to admin
    const _io = global._io;
    if (_io) {
      const adminId = user.createdBy || null;
      const payload = {
        userId:    String(userId),
        userName:  user.name,
        reason:    (reason || '').trim(),
        location:  (location || '').trim(),
        requestedAt: new Date().toISOString(),
      };
      if (adminId) {
        _io.to(`admin_room:${String(adminId)}`).emit('meeting_permission_requested', payload);
      }
      // Also emit to company-wide admin room so any online admin sees it
      _io.to(`company_admin:${String(companyId)}`).emit('meeting_permission_requested', payload);
    }

    res.json({ message: 'Request sent to admin. You will be notified once approved.', status: 'pending' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /attendance/meeting-permission-status ─────────────────────────────────
// Employee polls their permission status (approved / pending / denied)
const getMeetingPermissionStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('clientMeetingPermission clientMeetingPermissionGrantedAt meetingPermissionStatus meetingPermissionRequested')
      .lean();

    const isActive = (() => {
      if (!user.clientMeetingPermission) return false;
      if (!user.clientMeetingPermissionGrantedAt) return false;
      return (Date.now() - new Date(user.clientMeetingPermissionGrantedAt).getTime()) < 24 * 60 * 60 * 1000;
    })();

    res.json({
      hasPermission: isActive,
      grantedAt:     user.clientMeetingPermissionGrantedAt || null,
      status:        isActive ? 'approved' : (user.meetingPermissionStatus || 'none'),
      isPending:     user.meetingPermissionRequested && user.meetingPermissionStatus === 'pending',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /attendance/location-ping ───────────────────────────────────────────
// Mobile app sends periodic GPS pings while employee has clientMeetingPermission.
// Requires employee's explicit location consent (app already requested permission).
// Silently rejects if:
//   - company.meetingLocationTrackingEnabled is false
//   - employee does not have active (< 24h) clientMeetingPermission
const locationPing = async (req, res) => {
  try {
    const userId    = req.user._id;
    const companyId = req.user.company;
    const { latitude, longitude, accuracy, address } = req.body;

    if (latitude == null || longitude == null) {
      return res.status(400).json({ message: 'latitude and longitude required' });
    }

    // Check company tracking toggle
    const Company = require('../models/Company');
    const company = await Company.findById(companyId)
      .select('meetingLocationTrackingEnabled')
      .lean();
    if (!company?.meetingLocationTrackingEnabled) {
      return res.json({ stored: false, reason: 'tracking_disabled' });
    }

    // Check employee has active meeting permission (< 24h)
    const userDoc = await User.findById(userId)
      .select('clientMeetingPermission clientMeetingPermissionGrantedAt')
      .lean();
    const hasPermission = (() => {
      if (!userDoc?.clientMeetingPermission) return false;
      if (!userDoc.clientMeetingPermissionGrantedAt) return false;
      return (Date.now() - new Date(userDoc.clientMeetingPermissionGrantedAt).getTime()) < 24 * 60 * 60 * 1000;
    })();
    if (!hasPermission) {
      return res.json({ stored: false, reason: 'no_meeting_permission' });
    }

    const LiveLocation = require('../models/LiveLocation');
    const ping = await LiveLocation.create({
      user:      userId,
      company:   companyId,
      latitude:  Number(latitude),
      longitude: Number(longitude),
      accuracy:  accuracy != null ? Number(accuracy) : null,
      address:   (address || '').trim() || null,
      date:      todayStr(),
      context:   'meeting',
      capturedAt: new Date(),
    });

    // Emit to admin room so live map updates in real-time (optional enhancement)
    const _io = global._io;
    if (_io) {
      _io.to(`company_admin:${String(companyId)}`).emit('employee_location_ping', {
        userId:    String(userId),
        userName:  req.user.name,
        latitude:  ping.latitude,
        longitude: ping.longitude,
        address:   ping.address,
        capturedAt: ping.capturedAt,
      });
    }

    res.json({ stored: true, pingId: ping._id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /attendance/live-locations ────────────────────────────────────────────
// Admin/superadmin fetches today's location trail for all employees with
// meeting permission. Returns the last N pings per employee.
const getLiveLocations = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const date      = todayStr();
    const limit     = Math.min(200, parseInt(req.query.limit || '50', 10));
    const userId    = req.query.userId || null; // optional filter by employee

    const LiveLocation = require('../models/LiveLocation');
    const query = { company: companyId, date };
    if (userId) query.user = userId;

    const pings = await LiveLocation.find(query)
      .sort({ capturedAt: -1 })
      .limit(limit)
      .populate('user', 'name email')
      .lean();

    res.json({ pings, date, total: pings.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /attendance/meeting-tracking-config ────────────────────────────────────
// Employee fetches current tracking settings (enabled + interval) on clock-in
const getMeetingTrackingConfig = async (req, res) => {
  try {
    const Company = require('../models/Company');
    const company = await Company.findById(req.user.company)
      .select('meetingLocationTrackingEnabled meetingLocationIntervalMinutes')
      .lean();
    res.json({
      enabled:          company?.meetingLocationTrackingEnabled || false,
      intervalMinutes:  company?.meetingLocationIntervalMinutes || 15,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /admin/company/meeting-tracking ───────────────────────────────────────
// Admin sets the meeting location tracking toggle + interval
const saveMeetingTrackingConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { enabled, intervalMinutes } = req.body;
    const Company = require('../models/Company');
    const update = {};
    if (enabled !== undefined) update.meetingLocationTrackingEnabled = Boolean(enabled);
    if (intervalMinutes != null) {
      const mins = Math.max(5, Math.min(60, parseInt(intervalMinutes, 10)));
      update.meetingLocationIntervalMinutes = mins;
    }
    await Company.findByIdAndUpdate(companyId, { $set: update });
    res.json({ message: 'Meeting tracking config saved.', ...update });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  clockIn, clockOut, startBreak, endBreak, pingActivity, getMyToday,
  getCompanyAttendance, markIdleUsers,
  getAttendanceReport, editAttendance, deleteAttendance, exportAttendance,
  getCompanyUsers,
  requestMeetingPermission,
  getMeetingPermissionStatus,
  locationPing,
  getLiveLocations,
  getMeetingTrackingConfig,
  saveMeetingTrackingConfig,
};
