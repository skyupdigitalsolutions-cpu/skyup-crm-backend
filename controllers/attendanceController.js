const Attendance = require("../models/Attendance");
const User = require("../models/Users");

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

// ── USER: Clock In ─────────────────────────────────────────────────────────────
const clockIn = async (req, res) => {
  try {
    const userId = req.user._id;
    const companyId = req.user.company;
    const date = todayStr();

    let record = await Attendance.findOne({ user: userId, date });
    if (record && record.loginTime && !record.logoutTime)
      return res.status(400).json({ message: "Already clocked in." });

    if (record) {
      record.loginTime = new Date();
      record.logoutTime = null;
      record.status = "active";
      record.breaks = [];
      record.totalBreakMinutes = 0;
      record.totalWorkMinutes = 0;
      record.lastActivity = new Date();
      record.activeBreakIndex = null;
      await record.save();
    } else {
      record = await Attendance.create({
        user: userId, company: companyId, date,
        loginTime: new Date(), status: "active", lastActivity: new Date(),
      });
    }

    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: Clock Out ────────────────────────────────────────────────────────────
const clockOut = async (req, res) => {
  try {
    const date = todayStr();
    const record = await Attendance.findOne({ user: req.user._id, date });
    if (!record || !record.loginTime)
      return res.status(400).json({ message: "Not clocked in." });

    // Close any open break
    if (record.activeBreakIndex !== null) {
      const br = record.breaks[record.activeBreakIndex];
      if (br && !br.endTime) {
        br.endTime = new Date();
        br.durationMinutes = Math.round((br.endTime - br.startTime) / 60000);
      }
    }

    record.logoutTime = new Date();
    record.status = "logged_out";
    record.totalBreakMinutes = calcBreakMinutes(record.breaks);
    const elapsed = Math.round((record.logoutTime - record.loginTime) / 60000);
    record.totalWorkMinutes = Math.max(0, elapsed - record.totalBreakMinutes);
    record.activeBreakIndex = null;
    await record.save();

    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: Start Break ──────────────────────────────────────────────────────────
const startBreak = async (req, res) => {
  try {
    const { reason = "Manual Break" } = req.body;
    const date = todayStr();
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

// ── USER: End Break ────────────────────────────────────────────────────────────
const endBreak = async (req, res) => {
  try {
    const date = todayStr();
    const record = await Attendance.findOne({ user: req.user._id, date });
    if (!record || record.activeBreakIndex === null)
      return res.status(400).json({ message: "Not on break." });

    const br = record.breaks[record.activeBreakIndex];
    br.endTime = new Date();
    br.durationMinutes = Math.round((br.endTime - br.startTime) / 60000);
    record.totalBreakMinutes = calcBreakMinutes(record.breaks);
    record.activeBreakIndex = null;
    record.status = "active";
    record.lastActivity = new Date();
    await record.save();

    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: Ping Activity (every 60s from frontend) ─────────────────────────────
const pingActivity = async (req, res) => {
  try {
    const date = todayStr();
    const record = await Attendance.findOne({ user: req.user._id, date });
    if (!record || !record.loginTime || record.logoutTime)
      return res.status(200).json({ ok: true });

    record.lastActivity = new Date();
    if (record.status === "idle") {
      // If idle and user pinged → auto-end idle break
      if (record.activeBreakIndex !== null) {
        const br = record.breaks[record.activeBreakIndex];
        if (br && !br.endTime) {
          br.endTime = new Date();
          br.durationMinutes = Math.round((br.endTime - br.startTime) / 60000);
        }
      }
      record.activeBreakIndex = null;
      record.status = "active";
      record.totalBreakMinutes = calcBreakMinutes(record.breaks);
    }
    await record.save();
    res.status(200).json({ ok: true, status: record.status });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── USER: Get today's record ───────────────────────────────────────────────────
const getMyToday = async (req, res) => {
  try {
    const date = todayStr();
    let record = await Attendance.findOne({ user: req.user._id, date });
    if (!record) return res.status(200).json(null);
    res.status(200).json(record);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ADMIN: Mark idle users (called by a cron or on-demand) ────────────────────
// Any user whose lastActivity is >5 min ago AND status=active → set idle + open break
const markIdleUsers = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const date = todayStr();
    const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago

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

// ── ADMIN: Get all users attendance for a date ────────────────────────────────
const getCompanyAttendance = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const { date = todayStr() } = req.query;

    // Get all users of this company
    const users = await User.find({ company: companyId }).select("name email").lean();

    // Get all attendance records for that date
    const records = await Attendance.find({ company: companyId, date })
      .populate("user", "name email").lean();

    const recordMap = {};
    records.forEach(r => { recordMap[String(r.user?._id || r.user)] = r; });

    // For active users, compute live work minutes
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
      // Check if idle (lastActivity > 5 min ago and status=active)
      let status = rec.status;
      if (status === "active" && rec.lastActivity && (now - new Date(rec.lastActivity)) > 5 * 60 * 1000) {
        status = "idle";
      }
      return { ...rec, user: u, status, liveWorkMinutes: liveWork };
    });

    res.status(200).json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

module.exports = { clockIn, clockOut, startBreak, endBreak, pingActivity, getMyToday, getCompanyAttendance, markIdleUsers };