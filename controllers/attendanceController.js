const Attendance = require("../models/Attendance");
const User       = require("../models/Users");

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

// ── USER: Clock In ────────────────────────────────────────────────────────────
const DEVICE_FIELDS_ATT = ["appName", "appVersion", "platform", "deviceModel", "osVersion", "fcmToken"];

const clockIn = async (req, res) => {
  try {
    const userId    = req.user._id;
    const companyId = req.user.company;
    const date      = todayStr();

    // ── Pull device / app info if the mobile app sent it ──────────────────────
    const deviceFields = {};
    DEVICE_FIELDS_ATT.forEach(f => {
      if (req.body[f] !== undefined && req.body[f] !== null) {
        deviceFields[f] = req.body[f];
      }
    });

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

    const users   = await User.find({ company: companyId }).select("name email").lean();
    const records = await Attendance.find({ company: companyId, date })
      .populate("user", "name email").lean();

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

    // Build base query
    const query = { company: companyId, date: { $gte: from, $lte: to } };
    if (userId) query.user = userId;

    // Fetch records
    const [records, total] = await Promise.all([
      Attendance.find(query)
        .populate("user", "name email")
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

    // Get all users for the company (for absent rows — users with no record)
    const allUsers = await User.find({ company: companyId }).select("name email").lean();

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

    const query = { company: companyId, date: { $gte: from, $lte: to } };
    if (userId) query.user = userId;

    const records = await Attendance.find(query)
      .populate("user", "name email")
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
    const users = await User.find({ company: req.admin.company._id })
      .select("name email").lean();
    res.status(200).json(users);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// Helper
function formatWorkHours(mins) {
  if (!mins) return "0h 00m";
  return `${Math.floor(mins / 60)}h ${(mins % 60).toString().padStart(2, "0")}m`;
}

module.exports = {
  clockIn, clockOut, startBreak, endBreak, pingActivity, getMyToday,
  getCompanyAttendance, markIdleUsers,
  getAttendanceReport, editAttendance, deleteAttendance, exportAttendance,
  getCompanyUsers,
};