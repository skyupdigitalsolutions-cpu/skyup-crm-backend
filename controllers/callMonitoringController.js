// controllers/callMonitoringController.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin "Call Monitoring" analytics — built on top of MobileCallLog, which the
// Android app already syncs (SIM-based call logs + recordings).
//
// Endpoints (mounted under /api/call-logs/monitoring, see routes/mobileCallLog.js):
//   GET /summary         → call-type totals, per-employee report, hourly/daily
//                          trends, duration buckets, top numbers
//   GET /history         → paginated, filterable call history
//   GET /never-attended  → missed/rejected callers that nobody connected with
//                          afterwards (callback tracking)
//
// Common query params:
//   startDate, endDate   YYYY-MM-DD in the viewer's local calendar (default: today)
//   tzOffset             viewer's UTC offset in minutes (IST = 330, default 330)
//   userId               optional — drill down to one employee
//
// Scoping (matches adminController.getCompanyUsers):
//   • super_admin → every employee in the company
//   • admin       → only employees this admin created (User.createdBy)
//   • employees   → 403 (this is an admin-only report)
//
// Definitions (same as common call-monitoring tools):
//   connected      incoming/outgoing call with duration > 0
//   not picked up  outgoing call with duration 0 (client didn't answer)
//   working hours  per day: first call start → last call end, summed over days
//   unique clients distinct normalised phone numbers
// ─────────────────────────────────────────────────────────────────────────────

const mongoose      = require("mongoose");
const MobileCallLog = require("../models/MobileCallLog");
const User          = require("../models/Users");
const Attendance    = require("../models/Attendance");
const Lead          = require("../models/Leads");
const { escapeRegex } = require("../utils/escapeRegex");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 92;
const CALL_TYPES = ["incoming", "outgoing", "missed", "rejected", "voicemail", "blocked", "unknown"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTzOffset(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < -720 || n > 840) return 330;
  return n;
}

// Mongo $dateToString / $hour accept "+05:30" style offsets.
function tzString(offsetMin) {
  const sign = offsetMin < 0 ? "-" : "+";
  const abs  = Math.abs(offsetMin);
  const hh   = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm   = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function localDayKey(date, offsetMin) {
  return new Date(date.getTime() + offsetMin * 60000).toISOString().slice(0, 10);
}

function isDateKey(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Local YYYY-MM-DD → UTC instant of that local midnight.
function localMidnightUTC(key, offsetMin) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - offsetMin * 60000);
}

function resolveRange(query) {
  const tz    = parseTzOffset(query.tzOffset);
  const today = localDayKey(new Date(), tz);
  let startKey = isDateKey(query.startDate) ? query.startDate : today;
  let endKey   = isDateKey(query.endDate)   ? query.endDate   : startKey;
  if (endKey < startKey) [startKey, endKey] = [endKey, startKey];

  const start = localMidnightUTC(startKey, tz);
  let   end   = new Date(localMidnightUTC(endKey, tz).getTime() + DAY_MS); // exclusive

  // Clamp absurd ranges so a single request can't aggregate years of logs.
  if (end - start > MAX_RANGE_DAYS * DAY_MS) {
    end    = new Date(start.getTime() + MAX_RANGE_DAYS * DAY_MS);
    endKey = localDayKey(new Date(end.getTime() - 1), tz);
  }
  return { tz, tzStr: tzString(tz), startKey, endKey, start, end };
}

function isSuperAdmin(admin) {
  const role = admin && admin.role;
  return !!(admin && (admin.isSuperAdmin || role === "super_admin" || role === "superadmin"));
}

// Resolves the set of employees the caller may see. Sends the error response
// itself and returns null when the caller isn't allowed.
async function resolveScope(req, res) {
  if (!req.admin) {
    res.status(403).json({ message: "Call monitoring is available to admins only." });
    return null;
  }
  const company = req.callerCompany;
  if (!company) {
    res.status(400).json({ message: "Company not resolved for this session." });
    return null;
  }

  const userFilter = { company };
  if (!isSuperAdmin(req.admin)) userFilter.createdBy = req.admin._id;

  const users = await User.find(userFilter)
    .select("name email deviceModel appVersion platform lastLoginAt callLogSyncEnabled")
    .lean();

  let scopedUsers = users;
  if (req.query.userId) {
    if (!mongoose.Types.ObjectId.isValid(String(req.query.userId))) {
      res.status(400).json({ message: "Invalid userId." });
      return null;
    }
    scopedUsers = users.filter((u) => String(u._id) === String(req.query.userId));
    if (!scopedUsers.length) {
      res.status(404).json({ message: "Employee not found in your team." });
      return null;
    }
  }

  return {
    company: new mongoose.Types.ObjectId(String(company)),
    users,                                   // everyone the admin can see (for the filter dropdown)
    scopedUsers,                             // after the optional userId drill-down
    userIds: scopedUsers.map((u) => u._id),
  };
}

const phoneKeyExpr = { $ifNull: ["$normalizedPhone", "$phoneNumber"] };
const isConnectedExpr = {
  $and: [{ $in: ["$callType", ["incoming", "outgoing"]] }, { $gt: ["$duration", 0] }],
};
const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const sumIf   = (cond, field) => ({ $sum: { $cond: [cond, field, 0] } });
const typeIs  = (t) => ({ $eq: ["$callType", t] });

// ── GET /api/call-logs/monitoring/summary ─────────────────────────────────────
const getMonitoringSummary = async (req, res) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const range = resolveRange(req.query);

    const match = {
      company:   scope.company,
      user:      { $in: scope.userIds },
      timestamp: { $gte: range.start, $lt: range.end },
    };

    const [facet] = await MobileCallLog.aggregate([
      { $match: match },
      {
        $facet: {
          byType: [
            { $group: {
              _id: "$callType",
              count:     { $sum: 1 },
              duration:  { $sum: "$duration" },
              connected: { $sum: { $cond: [{ $gt: ["$duration", 0] }, 1, 0] } },
            } },
          ],

          byUser: [
            { $group: {
              _id: "$user",
              totalCalls:        { $sum: 1 },
              totalDuration:     { $sum: "$duration" },
              incoming:          countIf(typeIs("incoming")),
              incomingDuration:  sumIf(typeIs("incoming"), "$duration"),
              outgoing:          countIf(typeIs("outgoing")),
              outgoingDuration:  sumIf(typeIs("outgoing"), "$duration"),
              outgoingConnected: countIf({ $and: [typeIs("outgoing"), { $gt: ["$duration", 0] }] }),
              missed:            countIf(typeIs("missed")),
              rejected:          countIf(typeIs("rejected")),
              connected:         countIf(isConnectedExpr),
              longestCall:       { $max: "$duration" },
              recordings:        { $sum: { $size: { $ifNull: ["$recordings", []] } } },
              firstCallAt:       { $min: "$timestamp" },
              lastCallAt:        { $max: "$timestamp" },
            } },
          ],

          uniqueByUser: [
            { $group: { _id: { user: "$user", phone: phoneKeyExpr } } },
            { $group: { _id: "$_id.user", uniqueClients: { $sum: 1 } } },
          ],

          // Per-user, per-day "first call start → last call end" span.
          spanByUser: [
            { $group: {
              _id: {
                user: "$user",
                day:  { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: range.tzStr } },
              },
              first: { $min: "$timestamp" },
              last:  { $max: { $add: ["$timestamp", { $multiply: ["$duration", 1000] }] } },
            } },
            { $group: {
              _id: "$_id.user",
              workingSeconds: { $sum: { $divide: [{ $subtract: ["$last", "$first"] }, 1000] } },
              activeDays:     { $sum: 1 },
            } },
          ],

          uniqueTotal: [
            { $group: { _id: phoneKeyExpr } },
            { $count: "n" },
          ],

          hourly: [
            { $group: {
              _id: { $hour: { date: "$timestamp", timezone: range.tzStr } },
              total:    { $sum: 1 },
              incoming: countIf(typeIs("incoming")),
              outgoing: countIf(typeIs("outgoing")),
              missed:   countIf({ $in: ["$callType", ["missed", "rejected"]] }),
              connected: countIf(isConnectedExpr),
            } },
            { $sort: { _id: 1 } },
          ],

          daily: [
            { $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: range.tzStr } },
              total:     { $sum: 1 },
              incoming:  countIf(typeIs("incoming")),
              outgoing:  countIf(typeIs("outgoing")),
              missed:    countIf({ $in: ["$callType", ["missed", "rejected"]] }),
              connected: countIf(isConnectedExpr),
              duration:  { $sum: "$duration" },
            } },
            { $sort: { _id: 1 } },
          ],

          durationBuckets: [
            { $match: { $expr: isConnectedExpr } },
            { $bucket: {
              groupBy: "$duration",
              boundaries: [1, 30, 60, 300, 600],
              default: "600+",
              output: { count: { $sum: 1 } },
            } },
          ],

          topNumbers: [
            { $sort: { timestamp: -1 } },
            { $group: {
              _id: phoneKeyExpr,
              phoneNumber: { $first: "$phoneNumber" },
              name:        { $max: "$name" },
              matchedLead: { $first: "$matchedLead" },
              calls:       { $sum: 1 },
              duration:    { $sum: "$duration" },
              connected:   countIf(isConnectedExpr),
              lastCallAt:  { $first: "$timestamp" },
            } },
            { $sort: { calls: -1, duration: -1 } },
            { $limit: 10 },
          ],
        },
      },
    ]).allowDiskUse(true);

    // ── Call-type summary ──────────────────────────────────────────────────
    const types = {};
    for (const t of CALL_TYPES) types[t] = { count: 0, duration: 0, connected: 0 };
    for (const row of facet.byType) {
      const key = CALL_TYPES.includes(row._id) ? row._id : "unknown";
      types[key].count     += row.count;
      types[key].duration  += row.duration;
      types[key].connected += row.connected;
    }
    const totalCalls    = Object.values(types).reduce((a, t) => a + t.count, 0);
    const totalDuration = Object.values(types).reduce((a, t) => a + t.duration, 0);
    const connected     = types.incoming.connected + types.outgoing.connected;

    // ── Attendance (clocked-in minutes) for the same days ──────────────────
    const attendance = await Attendance.find({
      company: scope.company,
      user:    { $in: scope.userIds },
      date:    { $gte: range.startKey, $lte: range.endKey },
    }).select("user loginTime logoutTime totalWorkMinutes totalBreakMinutes breaks activeBreakIndex").lean();

    const now = Date.now();
    const clockedByUser = new Map();
    for (const rec of attendance) {
      let mins = rec.totalWorkMinutes || 0;
      // Still clocked in → compute live minutes, same as attendanceController.
      if (rec.loginTime && !rec.logoutTime) {
        const activeBreak = rec.activeBreakIndex !== null && rec.activeBreakIndex !== undefined
          ? rec.breaks && rec.breaks[rec.activeBreakIndex] : null;
        const openBreakMins = activeBreak && activeBreak.startTime
          ? Math.round((now - new Date(activeBreak.startTime)) / 60000) : 0;
        mins = Math.max(0, Math.round((now - new Date(rec.loginTime)) / 60000) - (rec.totalBreakMinutes || 0) - openBreakMins);
      }
      const k = String(rec.user);
      clockedByUser.set(k, (clockedByUser.get(k) || 0) + mins);
    }

    // ── Per-employee report (every scoped employee, even with zero calls) ──
    const byUser   = new Map(facet.byUser.map((r) => [String(r._id), r]));
    const uniqueBy = new Map(facet.uniqueByUser.map((r) => [String(r._id), r.uniqueClients]));
    const spanBy   = new Map(facet.spanByUser.map((r) => [String(r._id), r]));

    const employees = scope.scopedUsers.map((u) => {
      const id = String(u._id);
      const r  = byUser.get(id) || {};
      const s  = spanBy.get(id) || {};
      return {
        userId:            id,
        name:              u.name,
        email:             u.email,
        deviceModel:       u.deviceModel || null,
        appVersion:        u.appVersion || null,
        callLogSyncEnabled: u.callLogSyncEnabled !== false,
        totalCalls:        r.totalCalls || 0,
        totalDuration:     r.totalDuration || 0,
        incoming:          r.incoming || 0,
        incomingDuration:  r.incomingDuration || 0,
        outgoing:          r.outgoing || 0,
        outgoingDuration:  r.outgoingDuration || 0,
        outgoingConnected: r.outgoingConnected || 0,
        notPickedUp:       Math.max(0, (r.outgoing || 0) - (r.outgoingConnected || 0)),
        missed:            r.missed || 0,
        rejected:          r.rejected || 0,
        connected:         r.connected || 0,
        uniqueClients:     uniqueBy.get(id) || 0,
        longestCall:       r.longestCall || 0,
        avgDuration:       r.connected ? Math.round((r.totalDuration || 0) / r.connected) : 0,
        recordings:        r.recordings || 0,
        workingSeconds:    Math.round(s.workingSeconds || 0),
        activeDays:        s.activeDays || 0,
        clockedMinutes:    clockedByUser.get(id) || 0,
        firstCallAt:       r.firstCallAt || null,
        lastCallAt:        r.lastCallAt || null,
      };
    }).sort((a, b) => b.totalCalls - a.totalCalls || a.name.localeCompare(b.name));

    // ── Hourly (0-23, always 24 rows) and daily (every day in range) ───────
    const hourMap = new Map(facet.hourly.map((h) => [h._id, h]));
    const hourly = Array.from({ length: 24 }, (_, h) => {
      const row = hourMap.get(h) || {};
      return { hour: h, total: row.total || 0, incoming: row.incoming || 0, outgoing: row.outgoing || 0, missed: row.missed || 0, connected: row.connected || 0 };
    });

    const dayMap = new Map(facet.daily.map((d) => [d._id, d]));
    const daily = [];
    for (let t = localMidnightUTC(range.startKey, range.tz).getTime(); t < range.end.getTime(); t += DAY_MS) {
      const key = localDayKey(new Date(t), range.tz);
      const row = dayMap.get(key) || {};
      daily.push({ date: key, total: row.total || 0, incoming: row.incoming || 0, outgoing: row.outgoing || 0, missed: row.missed || 0, connected: row.connected || 0, duration: row.duration || 0 });
    }

    const bucketLabels = { 1: "Under 30s", 30: "30s – 1m", 60: "1 – 5m", 300: "5 – 10m", "600+": "Over 10m" };
    const bucketMap = new Map(facet.durationBuckets.map((b) => [String(b._id), b.count]));
    const durationBuckets = ["1", "30", "60", "300", "600+"].map((k) => ({
      label: bucketLabels[k], count: bucketMap.get(k) || 0,
    }));

    // Attach lead name/status to the top numbers (plain find — avoids $lookup
    // sub-pipeline syntax that needs MongoDB 5+).
    const topLeadIds = facet.topNumbers.map((t) => t.matchedLead).filter(Boolean);
    const topLeads = topLeadIds.length
      ? await Lead.find({ _id: { $in: topLeadIds }, company: scope.company }).select("name status").lean()
      : [];
    const topLeadMap = new Map(topLeads.map((l) => [String(l._id), l]));
    const topNumbers = facet.topNumbers.map(({ matchedLead, ...t }) => ({
      ...t, lead: matchedLead ? topLeadMap.get(String(matchedLead)) || null : null,
    }));

    res.json({
      range: { startDate: range.startKey, endDate: range.endKey, tzOffset: range.tz },
      summary: {
        totalCalls,
        totalDuration,
        connected,
        notPickedUp:   types.outgoing.count - types.outgoing.connected,
        uniqueClients: (facet.uniqueTotal[0] && facet.uniqueTotal[0].n) || 0,
        avgDuration:   connected ? Math.round(totalDuration / connected) : 0,
        activeEmployees: employees.filter((e) => e.totalCalls > 0).length,
        totalEmployees:  employees.length,
        types,
      },
      employees,
      hourly,
      daily,
      durationBuckets,
      topNumbers,
      team: scope.users.map((u) => ({ _id: u._id, name: u.name, email: u.email })),
    });
  } catch (error) {
    console.error("[callMonitoring] summary error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/monitoring/history ─────────────────────────────────────
// Extra params: callType (incoming|outgoing|missed|rejected|connected|not_picked|
//                         outgoing_connected|missed_any),
//               phone (exact normalised number — drill-down from Clients),
//               search (phone digits or contact name), hasRecording=true,
//               sort (recent|duration), page, limit (max 500)
const getMonitoringHistory = async (req, res) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const range = resolveRange(req.query);

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const filter = {
      company:   scope.company,
      user:      { $in: scope.userIds },
      timestamp: { $gte: range.start, $lt: range.end },
    };

    const ct = String(req.query.callType || "");
    if (ct === "connected") {
      filter.callType = { $in: ["incoming", "outgoing"] };
      filter.duration = { $gt: 0 };
    } else if (ct === "not_picked") {
      filter.callType = "outgoing";
      filter.duration = 0;
    } else if (ct === "outgoing_connected") {
      filter.callType = "outgoing";
      filter.duration = { $gt: 0 };
    } else if (ct === "missed_any") {
      filter.callType = { $in: ["missed", "rejected"] };
    } else if (CALL_TYPES.includes(ct)) {
      filter.callType = ct;
    }

    if (String(req.query.hasRecording) === "true") {
      filter.recordings = { $elemMatch: { url: { $nin: ["", null] } } };
    }

    const search = String(req.query.search || "").trim().slice(0, 50);
    if (search) {
      const digits = search.replace(/\D/g, "");
      const or = [{ name: { $regex: escapeRegex(search), $options: "i" } }];
      if (digits.length >= 3) {
        or.push({ phoneNumber:     { $regex: escapeRegex(digits) } });
        or.push({ normalizedPhone: { $regex: escapeRegex(digits) } });
      }
      filter.$and = [{ $or: or }];
    }

    const phone = String(req.query.phone || "").trim().slice(0, 30);
    if (phone) {
      (filter.$and = filter.$and || []).push({ $or: [{ normalizedPhone: phone }, { phoneNumber: phone }] });
    }

    const sort = req.query.sort === "duration" ? { duration: -1, timestamp: -1 } : { timestamp: -1 };

    const [logs, total] = await Promise.all([
      MobileCallLog.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .select("-recordings.transcript")
        .populate("user", "name email")
        .populate("matchedLead", "name status remark")
        .lean(),
      MobileCallLog.countDocuments(filter),
    ]);

    // Drop placeholder recordings (auto-summary rows have an empty url).
    // Remarks: the agent's remark for this call when there is one; otherwise
    // the lead's latest remark (marked as such). Auto-generated texts like
    // "Outgoing call from mobile app (2m)" don't count as remarks.
    const AUTO_REMARK = /^(outgoing|incoming|missed|rejected|voicemail|blocked|unknown) call from mobile app/i;
    const realRemark = (r) => {
      const t = String(r || "").trim();
      return t && !AUTO_REMARK.test(t) ? t : "";
    };
    for (const l of logs) {
      l.recordings = (l.recordings || []).filter((r) => r && r.url);
      const callRemark = realRemark(l.remark);
      const leadRemark = realRemark(l.matchedLead && l.matchedLead.remark);
      l.remark = callRemark || null;
      l.leadRemark = leadRemark || null;
      if (l.matchedLead) delete l.matchedLead.remark;
    }

    res.json({ logs, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error("[callMonitoring] history error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/monitoring/never-attended ──────────────────────────────
// A caller counts as "never attended" when they had a missed/rejected call in
// the range and NO connected call (incoming or outgoing, by any teammate)
// happened with that number after their latest missed call.
const getNeverAttended = async (req, res) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const range = resolveRange(req.query);

    const missedGroups = await MobileCallLog.aggregate([
      { $match: {
        company:   scope.company,
        user:      { $in: scope.userIds },
        callType:  { $in: ["missed", "rejected"] },
        timestamp: { $gte: range.start, $lt: range.end },
      } },
      { $sort: { timestamp: -1 } },
      { $group: {
        _id:           phoneKeyExpr,
        phoneNumber:   { $first: "$phoneNumber" },
        name:          { $max: "$name" },
        matchedLead:   { $first: "$matchedLead" },
        missedCount:   { $sum: 1 },
        lastMissedAt:  { $first: "$timestamp" },
        firstMissedAt: { $last: "$timestamp" },
        users:         { $addToSet: "$user" },
      } },
      { $sort: { lastMissedAt: -1 } },
      { $limit: 2000 },
    ]).allowDiskUse(true);

    const phones = missedGroups.map((g) => g._id).filter(Boolean);

    // Latest connected call + latest outgoing attempt per number, company-wide,
    // any time after the range start (a callback can happen after endDate).
    const followUps = phones.length ? await MobileCallLog.aggregate([
      { $match: {
        company: scope.company,
        timestamp: { $gte: range.start },
        $or: [{ normalizedPhone: { $in: phones } }, { phoneNumber: { $in: phones } }],
        callType: { $in: ["incoming", "outgoing"] },
      } },
      { $group: {
        _id: phoneKeyExpr,
        lastConnectedAt: { $max: { $cond: [{ $gt: ["$duration", 0] }, "$timestamp", null] } },
        lastAttemptAt:   { $max: { $cond: [{ $eq: ["$callType", "outgoing"] }, "$timestamp", null] } },
        attempts:        { $sum: { $cond: [{ $eq: ["$callType", "outgoing"] }, 1, 0] } },
      } },
    ]) : [];
    const followMap = new Map(followUps.map((f) => [f._id, f]));

    const userName = new Map(scope.users.map((u) => [String(u._id), u.name]));

    let rows = missedGroups
      .map((g) => {
        const f = followMap.get(g._id) || {};
        const lastMissed = new Date(g.lastMissedAt).getTime();
        const attended = f.lastConnectedAt && new Date(f.lastConnectedAt).getTime() > lastMissed;
        if (attended) return null;
        const calledBack = f.lastAttemptAt && new Date(f.lastAttemptAt).getTime() > lastMissed;
        return {
          phoneKey:      g._id,
          phoneNumber:   g.phoneNumber,
          name:          g.name || "",
          matchedLead:   g.matchedLead || null,
          missedCount:   g.missedCount,
          lastMissedAt:  g.lastMissedAt,
          firstMissedAt: g.firstMissedAt,
          status:        calledBack ? "called_back_no_answer" : "not_called_back",
          lastAttemptAt: calledBack ? f.lastAttemptAt : null,
          employees:     g.users.map((id) => userName.get(String(id))).filter(Boolean),
        };
      })
      .filter(Boolean);

    const counts = {
      total:              rows.length,
      notCalledBack:      rows.filter((r) => r.status === "not_called_back").length,
      calledBackNoAnswer: rows.filter((r) => r.status === "called_back_no_answer").length,
    };

    const status = String(req.query.status || "");
    if (status === "not_called_back" || status === "called_back_no_answer") {
      rows = rows.filter((r) => r.status === status);
    }

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const pageRows = rows.slice((page - 1) * limit, page * limit);

    // Attach lead name/status only for the rows actually returned.
    const leadIds = [...new Set(pageRows.map((r) => r.matchedLead).filter(Boolean).map(String))];
    const leads = leadIds.length
      ? await Lead.find({ _id: { $in: leadIds }, company: scope.company }).select("name status").lean()
      : [];
    const leadMap = new Map(leads.map((l) => [String(l._id), l]));
    const out = pageRows.map(({ matchedLead, ...r }) => ({
      ...r, lead: matchedLead ? leadMap.get(String(matchedLead)) || null : null,
    }));

    res.json({
      rows: out,
      counts,
      total: rows.length,
      page,
      totalPages: Math.ceil(rows.length / limit),
    });
  } catch (error) {
    console.error("[callMonitoring] never-attended error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── GET /api/call-logs/monitoring/clients ─────────────────────────────────────
// One row per distinct phone number (the "Unique clients" figure), with call
// counts and talk time. Params: search, sort (calls|duration|recent|missed),
// page, limit (max 200).
const getMonitoringClients = async (req, res) => {
  try {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const range = resolveRange(req.query);

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const match = {
      company:   scope.company,
      user:      { $in: scope.userIds },
      timestamp: { $gte: range.start, $lt: range.end },
    };
    const search = String(req.query.search || "").trim().slice(0, 50);
    if (search) {
      const digits = search.replace(/\D/g, "");
      const or = [{ name: { $regex: escapeRegex(search), $options: "i" } }];
      if (digits.length >= 3) {
        or.push({ phoneNumber:     { $regex: escapeRegex(digits) } });
        or.push({ normalizedPhone: { $regex: escapeRegex(digits) } });
      }
      match.$or = or;
    }

    const SORTS = {
      calls:    { calls: -1, lastCallAt: -1 },
      duration: { duration: -1, calls: -1 },
      recent:   { lastCallAt: -1 },
      missed:   { missed: -1, lastCallAt: -1 },
    };
    const sort = SORTS[req.query.sort] || SORTS.calls;

    const [facet] = await MobileCallLog.aggregate([
      { $match: match },
      { $sort: { timestamp: -1 } },
      { $group: {
        _id:          phoneKeyExpr,
        phoneNumber:  { $first: "$phoneNumber" },
        name:         { $max: "$name" },
        matchedLead:  { $max: "$matchedLead" },
        calls:        { $sum: 1 },
        incoming:     countIf(typeIs("incoming")),
        outgoing:     countIf(typeIs("outgoing")),
        missed:       countIf({ $in: ["$callType", ["missed", "rejected"]] }),
        notPickedUp:  countIf({ $and: [typeIs("outgoing"), { $eq: ["$duration", 0] }] }),
        connected:    countIf(isConnectedExpr),
        duration:     { $sum: "$duration" },
        firstCallAt:  { $min: "$timestamp" },
        lastCallAt:   { $max: "$timestamp" },
        users:        { $addToSet: "$user" },
      } },
      { $facet: {
        rows:  [{ $sort: sort }, { $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: "n" }],
      } },
    ]).allowDiskUse(true);

    const rows  = facet.rows;
    const total = (facet.total[0] && facet.total[0].n) || 0;

    const leadIds = [...new Set(rows.map((r) => r.matchedLead).filter(Boolean).map(String))];
    const leads = leadIds.length
      ? await Lead.find({ _id: { $in: leadIds }, company: scope.company }).select("name status").lean()
      : [];
    const leadMap  = new Map(leads.map((l) => [String(l._id), l]));
    const userName = new Map(scope.users.map((u) => [String(u._id), u.name]));

    res.json({
      rows: rows.map(({ matchedLead, users, _id, ...r }) => ({
        ...r,
        phoneKey:  _id,
        lead:      matchedLead ? leadMap.get(String(matchedLead)) || null : null,
        employees: users.map((id) => userName.get(String(id))).filter(Boolean),
      })),
      total, page, totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("[callMonitoring] clients error:", error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getMonitoringSummary, getMonitoringHistory, getNeverAttended, getMonitoringClients };
