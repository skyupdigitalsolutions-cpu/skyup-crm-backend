// backend/services/reportService.js
// ─────────────────────────────────────────────────────────────────────────────
// Centralized report aggregation service.
// ALL report endpoints (admin, user, mobile) MUST call these functions
// so that counts are always consistent across dashboards.
//
// FIX: Previously each endpoint had its own filtering logic with different
// timezone handling, different dedup strategies, and different status maps —
// causing admin daily report and user daily report to show different numbers.
// ─────────────────────────────────────────────────────────────────────────────

const Lead        = require('../models/Leads');
const MobileCallLog = require('../models/MobileCallLog');
const mongoose    = require('mongoose');

// IST timezone offset in milliseconds (+5:30)
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert any date input to IST midnight and IST end-of-day (UTC values).
 * All MongoDB queries must use these boundaries so a lead created at
 * 00:15 IST is counted in the IST day, not the previous UTC day.
 */
function getISTDayBounds(dateInput) {
  const base = dateInput ? new Date(dateInput) : new Date();

  // Shift to IST, zero out time, then shift back to UTC
  const istMs     = base.getTime() + IST_OFFSET_MS;
  const istDate   = new Date(istMs);
  istDate.setUTCHours(0, 0, 0, 0);

  const dayStart  = new Date(istDate.getTime() - IST_OFFSET_MS);           // UTC start
  const dayEnd    = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1); // UTC end

  return { dayStart, dayEnd };
}

// ── getDailyReport ────────────────────────────────────────────────────────────
/**
 * Unified daily report used by admin panel AND user dashboard.
 *
 * @param {object} options
 * @param {string|ObjectId} options.company       - required
 * @param {string}          options.date          - ISO date string, defaults to today
 * @param {string|ObjectId} [options.userId]      - filter to single user (user dashboard)
 * @param {string}          [options.campaign]    - filter by campaign name
 * @param {string}          [options.status]      - filter by lead status
 */
async function getDailyReport({ company, date, userId, campaign, status } = {}) {
  if (!company) throw new Error('company is required');

  const { dayStart, dayEnd } = getISTDayBounds(date);

  // ── Base match for today's leads ─────────────────────────────────────────
  const baseMatch = {
    company: new mongoose.Types.ObjectId(company),
    date:    { $gte: dayStart, $lte: dayEnd },
  };
  if (userId)   baseMatch.user     = new mongoose.Types.ObjectId(userId);
  if (campaign) baseMatch.campaign = campaign;
  if (status)   baseMatch.status   = status;

  // ── Previous day for trend calculation ───────────────────────────────────
  const prevDate  = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
  const { dayStart: prevStart, dayEnd: prevEnd } = getISTDayBounds(prevDate);

  const prevMatch = { ...baseMatch, date: { $gte: prevStart, $lte: prevEnd } };
  delete prevMatch.status; // always compare all statuses for trend

  // ── Pending follow-ups (scheduledCalls not done) ──────────────────────────
  // Scoped to company (and optionally user) — NOT date-filtered
  // so we show ALL pending items, not just ones scheduled today.
  const followUpMatch = { company: new mongoose.Types.ObjectId(company) };
  if (userId) followUpMatch.user = new mongoose.Types.ObjectId(userId);

  const [todayLeads, prevLeads, followUpLeads] = await Promise.all([
    // Today's leads
    Lead.aggregate([
      { $match: baseMatch },
      {
        $lookup: {
          from:         'users',
          localField:   'user',
          foreignField: '_id',
          as:           'userInfo',
        },
      },
      {
        $project: {
          _id: 1, name: 1, mobile: 1, source: 1, campaign: 1,
          status: 1, date: 1, remark: 1, temperature: 1,
          user: 1, callHistory: 1, scheduledCalls: 1,
          assignedUserName: { $arrayElemAt: ['$userInfo.name', 0] },
        },
      },
    ]),

    // Previous day — for trend numbers only
    Lead.aggregate([
      { $match: prevMatch },
      { $group: {
        _id:       null,
        total:     { $sum: 1 },
        converted: { $sum: { $cond: [{ $eq: ['$status', 'Converted'] }, 1, 0] } },
      }},
    ]),

    // Pending follow-ups
    Lead.aggregate([
      { $match: { ...followUpMatch, 'scheduledCalls.done': false } },
      { $unwind: '$scheduledCalls' },
      { $match:  { 'scheduledCalls.done': false } },
      {
        $lookup: {
          from:         'users',
          localField:   'user',
          foreignField: '_id',
          as:           'userInfo',
        },
      },
      {
        $project: {
          _id: 1, name: 1, mobile: 1, source: 1, status: 1, remark: 1,
          scheduledAt:  '$scheduledCalls.scheduledAt',
          note:         '$scheduledCalls.note',
          type:         '$scheduledCalls.type',
          assignedUser: { $arrayElemAt: ['$userInfo.name', 0] },
        },
      },
      { $sort: { scheduledAt: 1 } },
      { $limit: 200 },
    ]),
  ]);

  // ── Aggregate counts ──────────────────────────────────────────────────────
  const total         = todayLeads.length;
  const converted     = todayLeads.filter(l => l.status === 'Converted').length;
  const inProgress    = todayLeads.filter(l => l.status === 'In Progress').length;
  const notInterested = todayLeads.filter(l => l.status === 'Not Interested').length;
  const newLeads      = todayLeads.filter(l => l.status === 'New').length;
  const contacted     = todayLeads.filter(l => l.status !== 'New').length;
  const unassigned    = todayLeads.filter(l => !l.user).length;

  const prevData      = prevLeads[0] || { total: 0, converted: 0 };
  const trendTotal    = total - prevData.total;
  const trendConverted = converted - prevData.converted;
  const convRate      = total > 0 ? Math.round((converted / total) * 100) : 0;

  // ── Call history for today ────────────────────────────────────────────────
  // Deduplicate by leadId + calledAt to prevent double-counting
  const callsMadeToday = [];
  const callKeySet     = new Set();
  for (const lead of todayLeads) {
    for (const c of (lead.callHistory || [])) {
      const calledAt = new Date(c.calledAt);
      if (calledAt >= dayStart && calledAt <= dayEnd) {
        const key = `${lead._id}_${calledAt.getTime()}`;
        if (!callKeySet.has(key)) {
          callKeySet.add(key);
          callsMadeToday.push({ leadId: lead._id, leadName: lead.name, ...c });
        }
      }
    }
  }

  // ── Employee breakdown ────────────────────────────────────────────────────
  const employeeMap = new Map();
  for (const lead of todayLeads) {
    const name = lead.assignedUserName || 'Unassigned';
    const uid  = String(lead.user || 'unassigned');
    if (!employeeMap.has(uid)) {
      employeeMap.set(uid, {
        userId: lead.user, name,
        leads: 0, converted: 0, inProgress: 0,
        callsToday: 0, callsMadeToday: [],
      });
    }
    const entry = employeeMap.get(uid);
    entry.leads++;
    if (lead.status === 'Converted')   entry.converted++;
    if (lead.status === 'In Progress') entry.inProgress++;
  }

  // Attach call counts per employee
  for (const c of callsMadeToday) {
    const lead    = todayLeads.find(l => String(l._id) === String(c.leadId));
    if (!lead) continue;
    const uid     = String(lead.user || 'unassigned');
    const entry   = employeeMap.get(uid);
    if (entry) entry.callsToday++;
  }

  const employees = [...employeeMap.values()].sort((a, b) => b.converted - a.converted);

  // ── Source breakdown ──────────────────────────────────────────────────────
  const sourceMap = new Map();
  for (const lead of todayLeads) {
    const src = lead.source?.trim() || 'Other';
    sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
  }
  const sources = [...sourceMap.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // ── Follow-up urgency labels ──────────────────────────────────────────────
  const now = new Date();
  const todayStart = getISTDayBounds().dayStart;
  const todayEnd   = getISTDayBounds().dayEnd;

  const followUps = followUpLeads.map(f => {
    const dueDate = new Date(f.scheduledAt);
    let urgency, daysLabel, dotColor;
    if (dueDate < todayStart) {
      const daysOver = Math.max(1, Math.floor((todayStart - dueDate) / 86400000));
      urgency   = 'overdue';
      daysLabel = daysOver === 1 ? '1 day overdue' : `${daysOver} days overdue`;
      dotColor  = '#DC2626';
    } else if (dueDate <= todayEnd) {
      urgency   = 'today';
      daysLabel = 'Due today';
      dotColor  = '#D97706';
    } else {
      const daysAhead = Math.ceil((dueDate - todayEnd) / 86400000);
      urgency   = 'upcoming';
      daysLabel = daysAhead === 1 ? 'Due tomorrow' : `Due in ${daysAhead} days`;
      dotColor  = '#2563EB';
    }
    return { ...f, urgency, daysLabel, dotColor };
  }).sort((a, b) => {
    const order = { overdue: 0, today: 1, upcoming: 2 };
    if (order[a.urgency] !== order[b.urgency]) return order[a.urgency] - order[b.urgency];
    return new Date(a.scheduledAt) - new Date(b.scheduledAt);
  });

  return {
    date:          date || new Date().toISOString().slice(0, 10),
    timezone:      'Asia/Kolkata',
    dayStart:      dayStart.toISOString(),
    dayEnd:        dayEnd.toISOString(),
    summary: {
      total, converted, inProgress, notInterested, newLeads,
      contacted, unassigned, convRate,
      trendTotal, trendConverted,
      callsMadeToday: callsMadeToday.length,
    },
    leads:      todayLeads,
    sources,
    employees,
    followUps,
    conversions: todayLeads.filter(l => l.status === 'Converted'),
  };
}

// ── getEmployeeReport ─────────────────────────────────────────────────────────
/**
 * Per-employee activity report for a given date range.
 *
 * @param {object} options
 * @param {string|ObjectId} options.company
 * @param {string}          [options.fromDate]  ISO date
 * @param {string}          [options.toDate]    ISO date
 * @param {string|ObjectId} [options.userId]    single employee
 */
async function getEmployeeReport({ company, fromDate, toDate, userId } = {}) {
  if (!company) throw new Error('company is required');

  const { dayStart: from } = getISTDayBounds(fromDate);
  const { dayEnd:   to   } = getISTDayBounds(toDate || fromDate);

  const match = {
    company: new mongoose.Types.ObjectId(company),
    date:    { $gte: from, $lte: to },
  };
  if (userId) match.user = new mongoose.Types.ObjectId(userId);

  const rows = await Lead.aggregate([
    { $match: match },
    {
      $group: {
        _id:         '$user',
        total:       { $sum: 1 },
        converted:   { $sum: { $cond: [{ $eq: ['$status', 'Converted'] },    1, 0] } },
        inProgress:  { $sum: { $cond: [{ $eq: ['$status', 'In Progress'] },  1, 0] } },
        notInt:      { $sum: { $cond: [{ $eq: ['$status', 'Not Interested'] }, 1, 0] } },
        newLeads:    { $sum: { $cond: [{ $eq: ['$status', 'New'] },          1, 0] } },
      },
    },
    {
      $lookup: {
        from:         'users',
        localField:   '_id',
        foreignField: '_id',
        as:           'userInfo',
      },
    },
    {
      $project: {
        userId:     '$_id',
        name:       { $arrayElemAt: ['$userInfo.name',  0] },
        email:      { $arrayElemAt: ['$userInfo.email', 0] },
        total: 1, converted: 1, inProgress: 1, notInt: 1, newLeads: 1,
        convRate: {
          $cond: [
            { $gt: ['$total', 0] },
            { $multiply: [{ $divide: ['$converted', '$total'] }, 100] },
            0,
          ],
        },
      },
    },
    { $sort: { converted: -1, total: -1 } },
  ]);

  return { from: from.toISOString(), to: to.toISOString(), employees: rows };
}

// ── getCampaignReport ─────────────────────────────────────────────────────────
/**
 * Per-campaign stats. Optionally filtered by date range.
 */
async function getCampaignReport({ company, fromDate, toDate } = {}) {
  if (!company) throw new Error('company is required');

  const match = { company: new mongoose.Types.ObjectId(company) };
  if (fromDate || toDate) {
    const { dayStart: from } = getISTDayBounds(fromDate);
    const { dayEnd:   to   } = getISTDayBounds(toDate || fromDate);
    match.date = { $gte: from, $lte: to };
  }

  const rows = await Lead.aggregate([
    { $match: match },
    {
      $group: {
        _id:       { $ifNull: ['$campaign', 'Direct / None'] },
        total:     { $sum: 1 },
        converted: { $sum: { $cond: [{ $eq: ['$status', 'Converted'] }, 1, 0] } },
        sources:   { $addToSet: '$source' },
      },
    },
    {
      $project: {
        campaign: '$_id',
        total: 1, converted: 1, sources: 1,
        convRate: {
          $cond: [
            { $gt: ['$total', 0] },
            { $multiply: [{ $divide: ['$converted', '$total'] }, 100] },
            0,
          ],
        },
      },
    },
    { $sort: { total: -1 } },
  ]);

  return { campaigns: rows };
}

module.exports = { getDailyReport, getEmployeeReport, getCampaignReport, getISTDayBounds };
