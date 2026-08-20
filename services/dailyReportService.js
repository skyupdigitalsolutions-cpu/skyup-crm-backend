// services/dailyReportService.js
// ─────────────────────────────────────────────────────────────────────────────
// Core aggregation engine for the Daily Employee Performance Report.
//
// Architecture:
//   1. getCompanyDayBounds(timezone, reportDate) → UTC date range for the
//      company's configured timezone. All queries use this range.
//   2. aggregateLeadStats(companyId, dayStart, dayEnd) → one MongoDB
//      aggregation that groups leads by employee in a single round-trip.
//   3. aggregateCallStats(companyId, userIds, dayStart, dayEnd) → one MongoDB
//      aggregation that groups MobileCallLog records by employee.
//   4. buildReport(companyId, config, reportDate) → merges both aggregations
//      into per-employee + company-total report object.
//   5. formatTelegramMessages(report, companyName) → splits into ≤4096-char
//      Telegram messages (Telegram's limit per message).
//   6. sendReport(config, report, companyName) → sends all messages.
//
// Performance:
//   • Only 2 MongoDB aggregations regardless of employee count → no N+1.
//   • Queries are bounded by company + date range using existing indexes:
//       Leads:         { company: 1, createdAt: -1 } and { company: 1, date: -1 }
//       MobileCallLog: { user: 1, timestamp: -1 } and { company: 1, ... }
//   • No Lead documents are loaded into Node.js — $group runs in MongoDB.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const mongoose         = require('mongoose');
const https            = require('https');
const Lead             = require('../models/Leads');
const MobileCallLog    = require('../models/MobileCallLog');
const User             = require('../models/Users');
const DailyReportHistory = require('../models/DailyReportHistory');
const NurtureRule        = require('../models/NurtureRule');
const WhatsAppMessage    = require('../models/WhatsAppMessage');

// ── Timezone-aware day bounds ─────────────────────────────────────────────────
/**
 * Given an IANA timezone and an optional date string ("YYYY-MM-DD"),
 * returns { dayStart, dayEnd } as UTC Date objects representing
 * midnight→23:59:59.999 in that timezone.
 *
 * Uses Intl.DateTimeFormat — no external dependency needed.
 */
function getCompanyDayBounds(timezone = 'Asia/Kolkata', reportDate = null) {
  // Build a date in the target timezone
  const tz = timezone || 'Asia/Kolkata';

  // If reportDate given, parse it; otherwise use "today" in that timezone
  let localDateStr;
  if (reportDate) {
    localDateStr = reportDate; // "YYYY-MM-DD"
  } else {
    // Get today's date string in the target timezone
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now); // "YYYY-MM-DD"
    localDateStr = parts;
  }

  // Parse YYYY-MM-DD
  const [year, month, day] = localDateStr.split('-').map(Number);

  // Construct midnight in the target timezone using a known trick:
  // Create a UTC date that, when expressed in the target TZ, is midnight.
  // We do this by finding the UTC offset at that local midnight.
  const localMidnight = new Date(`${localDateStr}T00:00:00`);

  // Get the offset by formatting a known UTC time and comparing
  const utcStr  = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(localMidnight);

  // More reliable approach: use a binary search to find UTC equivalent
  // Actually, the simplest reliable approach:
  // Create date at local midnight assuming it's UTC, then adjust by TZ offset
  function getUTCForLocalMidnight(dateStr, tz) {
    // Start with noon UTC on that day (to avoid DST edge cases near midnight)
    const noonUTC = new Date(`${dateStr}T12:00:00Z`);
    // Format it in the target timezone to see what local time that noon UTC is
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(noonUTC).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = parseInt(p.value, 10);
      return acc;
    }, {});
    // Local hour at UTC noon = 12 + offset_hours
    const localHour = parts.hour;
    const localMin  = parts.minute;
    // Offset from UTC in minutes
    const offsetMin = (localHour - 12) * 60 + localMin;
    // UTC midnight = local midnight - offset
    const dayStart = new Date(`${dateStr}T00:00:00Z`);
    dayStart.setUTCMinutes(dayStart.getUTCMinutes() - offsetMin);
    return dayStart;
  }

  const dayStart = getUTCForLocalMidnight(localDateStr, tz);
  const dayEnd   = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  return { dayStart, dayEnd, localDateStr };
}

// ── Today's date string in a given timezone ───────────────────────────────────
function getTodayInTimezone(timezone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ── Lead aggregation ──────────────────────────────────────────────────────────
/**
 * Returns per-employee lead stats for the given day.
 * Single $aggregate — no N+1 queries.
 *
 * Output shape (one entry per user):
 * {
 *   userId, userName,
 *   newLeads,        // leads created today
 *   hotLeads, warmLeads, coldLeads,
 *   statusCounts,    // { Converted, 'Not Interested', 'In Progress', ... }
 *   followUpDueToday, followUpCompleted, followUpPending, followUpOverdue,
 * }
 */
async function aggregateLeadStats(companyId, dayStart, dayEnd) {
  const cid = new mongoose.Types.ObjectId(companyId);
  const now  = new Date();

  const pipeline = [
    // ── 1. Match only this company's leads created today ─────────────────────
    {
      $match: {
        company:    cid,
        date:       { $gte: dayStart, $lte: dayEnd },
        mergedInto: null,
      },
    },
    // ── 2. Group by employee ──────────────────────────────────────────────────
    {
      $group: {
        _id:         '$user',
        newLeads:    { $sum: 1 },
        hot:         { $sum: { $cond: [{ $eq: ['$temperature', 'Hot'] },  1, 0] } },
        warm:        { $sum: { $cond: [{ $eq: ['$temperature', 'Warm'] }, 1, 0] } },
        cold:        { $sum: { $cond: [{ $eq: ['$temperature', 'Cold'] }, 1, 0] } },
        converted:   { $sum: { $cond: [{ $eq: ['$status', 'Converted'] },        1, 0] } },
        notInterested:{ $sum: { $cond: [{ $eq: ['$status', 'Not Interested'] },  1, 0] } },
        interested:  { $sum: { $cond: [{ $eq: ['$status', 'Interest'] },         1, 0] } },
        inProgress:  { $sum: { $cond: [{ $eq: ['$status', 'In Progress'] },      1, 0] } },
        closed:      { $sum: { $cond: ['$isClosed',                              1, 0] } },
      },
    },
    // ── 3. Lookup employee name ────────────────────────────────────────────────
    {
      $lookup: {
        from:         'users',
        localField:   '_id',
        foreignField: '_id',
        as:           'userDoc',
        pipeline:     [{ $project: { name: 1, role: 1 } }],
      },
    },
    { $addFields: { userName: { $arrayElemAt: ['$userDoc.name', 0] } } },
    { $project: { userDoc: 0 } },
  ];

  const leadRows = await Lead.aggregate(pipeline).allowDiskUse(false);

  // ── Follow-up stats — separate aggregation (different match: no date filter)
  // We need: due today, completed today, pending (future), overdue (past, not done)
  const todayStart = dayStart;
  const todayEnd   = dayEnd;

  const followUpPipeline = [
    {
      $match: {
        company:            cid,
        'scheduledCalls.0': { $exists: true }, // has at least one scheduledCall
        mergedInto:         null,
      },
    },
    { $unwind: '$scheduledCalls' },
    {
      $group: {
        _id:       '$user',
        dueToday: {
          $sum: {
            $cond: [{
              $and: [
                { $gte: ['$scheduledCalls.scheduledAt', todayStart] },
                { $lte: ['$scheduledCalls.scheduledAt', todayEnd] },
              ],
            }, 1, 0],
          },
        },
        completedToday: {
          $sum: {
            $cond: [{
              $and: [
                { $eq:  ['$scheduledCalls.done', true] },
                { $gte: ['$scheduledCalls.scheduledAt', todayStart] },
                { $lte: ['$scheduledCalls.scheduledAt', todayEnd] },
              ],
            }, 1, 0],
          },
        },
        pending: {
          $sum: {
            $cond: [{
              $and: [
                { $eq: ['$scheduledCalls.done', false] },
                { $gt: ['$scheduledCalls.scheduledAt', todayEnd] },
              ],
            }, 1, 0],
          },
        },
        overdue: {
          $sum: {
            $cond: [{
              $and: [
                { $eq:  ['$scheduledCalls.done', false] },
                { $lt:  ['$scheduledCalls.scheduledAt', todayStart] },
              ],
            }, 1, 0],
          },
        },
      },
    },
  ];

  const followUpRows = await Lead.aggregate(followUpPipeline).allowDiskUse(false);
  const followUpMap  = new Map(followUpRows.map(r => [String(r._id), r]));

  // Merge follow-up into lead rows
  return leadRows.map(row => {
    const fu = followUpMap.get(String(row._id)) || {};
    return {
      userId:         String(row._id),
      userName:       row.userName || 'Unknown',
      newLeads:       row.newLeads       || 0,
      hotLeads:       row.hot            || 0,
      warmLeads:      row.warm           || 0,
      coldLeads:      row.cold           || 0,
      converted:      row.converted      || 0,
      notInterested:  row.notInterested  || 0,
      interested:     row.interested     || 0,
      inProgress:     row.inProgress     || 0,
      closed:         row.closed         || 0,
      followUpDue:        fu.dueToday        || 0,
      followUpCompleted:  fu.completedToday  || 0,
      followUpPending:    fu.pending          || 0,
      followUpOverdue:    fu.overdue          || 0,
    };
  });
}

// ── Call log aggregation ──────────────────────────────────────────────────────
/**
 * Returns per-employee call stats for the given day.
 * Uses MobileCallLog.timestamp (the actual call time from the device).
 * Single $aggregate — no N+1.
 *
 * Output shape (one entry per user):
 * {
 *   userId,
 *   total, answered, unanswered, incoming, outgoing,
 *   totalDurationSec, avgDurationSec, maxDurationSec,
 *   outcomeCounts: { Interested: N, 'Not Interested': N, ... }
 * }
 */
async function aggregateCallStats(companyId, dayStart, dayEnd) {
  const cid = new mongoose.Types.ObjectId(companyId);

  const pipeline = [
    // ── Match this company's calls for today ──────────────────────────────────
    {
      $match: {
        company:   cid,
        timestamp: { $gte: dayStart, $lte: dayEnd },
      },
    },
    // ── Group by user ─────────────────────────────────────────────────────────
    {
      $group: {
        _id:      '$user',
        total:    { $sum: 1 },
        answered: {
          $sum: {
            $cond: [{
              $and: [
                // FIX: '$nin' is a query-language operator (valid in find()/
                // $match) — it does NOT exist in the aggregation expression
                // language, only '$in' does. Using it here threw
                // "Unrecognized expression '$nin'" on every run, which
                // crashed buildReport() and killed both the scheduled
                // report and any manual "Send Now"/"Test" attempt.
                { $not: [{ $in: ['$callType', ['missed', 'rejected', 'blocked']] }] },
                { $gt:  ['$duration', 0] },
              ],
            }, 1, 0],
          },
        },
        missed: {
          $sum: {
            $cond: [{ $in: ['$callType', ['missed', 'rejected', 'blocked']] }, 1, 0],
          },
        },
        incoming: { $sum: { $cond: [{ $eq: ['$callType', 'incoming'] }, 1, 0] } },
        outgoing: { $sum: { $cond: [{ $eq: ['$callType', 'outgoing'] }, 1, 0] } },
        // Duration (seconds) — only for answered calls (duration > 0)
        totalDuration: {
          $sum: {
            $cond: [{ $gt: ['$duration', 0] }, '$duration', 0],
          },
        },
        maxDuration: { $max: '$duration' },
        // Count answered calls separately for average calculation
        answeredCount: {
          $sum: { $cond: [{ $gt: ['$duration', 0] }, 1, 0] },
        },
      },
    },
  ];

  const rows = await MobileCallLog.aggregate(pipeline).allowDiskUse(false);

  return rows.map(row => ({
    userId:          String(row._id),
    total:           row.total        || 0,
    answered:        row.answered     || 0,
    unanswered:      row.missed       || 0,
    incoming:        row.incoming     || 0,
    outgoing:        row.outgoing     || 0,
    totalDurationSec:row.totalDuration || 0,
    maxDurationSec:  row.maxDuration  || 0,
    avgDurationSec:  row.answeredCount > 0
      ? Math.round(row.totalDuration / row.answeredCount)
      : 0,
  }));
}

// ── Outcome stats from Lead.callHistory ──────────────────────────────────────
// Counts outcomes logged today across all leads for the company.
async function getOutcomeStats(companyId, dayStart, dayEnd) {
  try {
    const pipeline = [
      {
        $match: {
          company:    new mongoose.Types.ObjectId(String(companyId)),
          mergedInto: null,
        },
      },
      { $unwind: '$callHistory' },
      {
        $match: {
          'callHistory.calledAt': { $gte: dayStart, $lte: dayEnd },
          'callHistory.outcome':  { $exists: true, $ne: '' },
        },
      },
      {
        $group: {
          _id:   '$callHistory.outcome',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ];

    const rows = await Lead.aggregate(pipeline).allowDiskUse(false);
    return rows.map(r => ({ outcome: r._id, count: r.count }));
  } catch (err) {
    console.warn('[DailyReport] getOutcomeStats error:', err.message);
    return [];
  }
}

// ── Status stats from all leads for the company ───────────────────────────────
// Counts current status of ALL leads (not just today's) — gives a snapshot
// of where the pipeline stands.
async function getStatusSnapshot(companyId) {
  try {
    const pipeline = [
      {
        $match: {
          company:    new mongoose.Types.ObjectId(String(companyId)),
          mergedInto: null,
          isClosed:   { $ne: true },
        },
      },
      {
        $group: {
          _id:   '$status',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ];

    const rows = await Lead.aggregate(pipeline).allowDiskUse(false);
    return rows.map(r => ({ status: r._id, count: r.count }));
  } catch (err) {
    console.warn('[DailyReport] getStatusSnapshot error:', err.message);
    return [];
  }
}

// ── Duration formatter ────────────────────────────────────────────────────────
function fmtDuration(sec) {
  if (!sec || sec <= 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2,'0')}s`;
  return `${s}s`;
}

// ── Build full report object ──────────────────────────────────────────────────
async function buildReport(companyId, config, reportDate) {
  const { dayStart, dayEnd, localDateStr } = getCompanyDayBounds(
    config.timezone,
    reportDate,
  );

  const [leadStats, callStats] = await Promise.all([
    aggregateLeadStats(companyId, dayStart, dayEnd),
    aggregateCallStats(companyId, dayStart, dayEnd),
  ]);

  // Build a map of userId → call stats
  const callMap  = new Map(callStats.map(r => [r.userId, r]));
  const leadMap  = new Map(leadStats.map(r => [r.userId, r]));

  // Union of all userIds that had ANY activity
  const userIds = new Set([...leadMap.keys(), ...callMap.keys()]);

  // Build per-employee rows
  const employees = [];
  for (const uid of userIds) {
    const ls = leadMap.get(uid) || {};
    const cs = callMap.get(uid) || {};
    employees.push({
      userId:   uid,
      name:     ls.userName || cs.userName || 'Unknown',
      leads: {
        new:          ls.newLeads      || 0,
        hot:          ls.hotLeads      || 0,
        warm:         ls.warmLeads     || 0,
        cold:         ls.coldLeads     || 0,
        converted:    ls.converted     || 0,
        notInterested:ls.notInterested || 0,
        interested:   ls.interested    || 0,
        inProgress:   ls.inProgress    || 0,
        closed:       ls.closed        || 0,
      },
      calls: {
        total:         cs.total            || 0,
        answered:      cs.answered         || 0,
        unanswered:    cs.unanswered       || 0,
        incoming:      cs.incoming         || 0,
        outgoing:      cs.outgoing         || 0,
        totalDurationSec: cs.totalDurationSec || 0,
        avgDurationSec:   cs.avgDurationSec   || 0,
        maxDurationSec:   cs.maxDurationSec   || 0,
      },
      followUp: {
        due:       ls.followUpDue       || 0,
        completed: ls.followUpCompleted || 0,
        pending:   ls.followUpPending   || 0,
        overdue:   ls.followUpOverdue   || 0,
      },
    });
  }

  // Sort employees by name
  employees.sort((a, b) => a.name.localeCompare(b.name));

  // ── Company totals ────────────────────────────────────────────────────────
  const totals = employees.reduce((acc, emp) => {
    acc.employees++;
    acc.newLeads       += emp.leads.new;
    acc.converted      += emp.leads.converted;
    acc.notInterested  += emp.leads.notInterested;
    acc.interested     += emp.leads.interested;
    acc.closed         += emp.leads.closed;
    acc.calls          += emp.calls.total;
    acc.answered       += emp.calls.answered;
    acc.unanswered     += emp.calls.unanswered;
    acc.incoming       += emp.calls.incoming;
    acc.outgoing       += emp.calls.outgoing;
    acc.totalDurationSec += emp.calls.totalDurationSec;
    if (emp.calls.maxDurationSec > acc.maxDurationSec)
      acc.maxDurationSec = emp.calls.maxDurationSec;
    acc.followUpDue       += emp.followUp.due;
    acc.followUpCompleted += emp.followUp.completed;
    acc.followUpPending   += emp.followUp.pending;
    acc.followUpOverdue   += emp.followUp.overdue;
    return acc;
  }, {
    employees: 0, newLeads: 0, converted: 0, notInterested: 0,
    interested: 0, closed: 0,
    calls: 0, answered: 0, unanswered: 0, incoming: 0, outgoing: 0,
    totalDurationSec: 0, maxDurationSec: 0,
    followUpDue: 0, followUpCompleted: 0, followUpPending: 0, followUpOverdue: 0,
  });

  totals.avgDurationSec = totals.answered > 0
    ? Math.round(totals.totalDurationSec / totals.answered)
    : 0;

  const hasActivity =
    totals.newLeads > 0 || totals.calls > 0 || totals.converted > 0;

  return {
    reportDate: localDateStr,
    hasActivity,
    employees,
    totals,
  };
}

// ── Telegram message formatter ────────────────────────────────────────────────
const MAX_MSG_LEN = 4000; // Telegram limit is 4096; leave some buffer

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(dateStr) {
  // "2026-08-10" → "10 August 2026"
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return `${d} ${months[m-1]} ${y}`;
}

function buildEmployeeBlock(emp) {
  const L = emp.leads;
  const C = emp.calls;
  const F = emp.followUp;

  let block = `\n👤 <b>${escapeHtml(emp.name)}</b>\n`;

  if (L.new > 0 || L.hot + L.warm + L.cold > 0) {
    block += `\n🆕 <b>LEADS</b>\n`;
    block += `• New Leads: ${L.new}\n`;
    if (L.hot)          block += `• Hot: ${L.hot}\n`;
    if (L.warm)         block += `• Warm: ${L.warm}\n`;
    if (L.cold)         block += `• Cold: ${L.cold}\n`;
    if (L.interested)   block += `• Interested: ${L.interested}\n`;
    if (L.converted)    block += `• Converted: ${L.converted}\n`;
    if (L.notInterested)block += `• Not Interested: ${L.notInterested}\n`;
    if (L.closed)       block += `• Closed: ${L.closed}\n`;
  }

  if (C.total > 0) {
    block += `\n📞 <b>CALLS</b>\n`;
    block += `• Total: ${C.total}\n`;
    block += `• Answered: ${C.answered}\n`;
    block += `• Unanswered: ${C.unanswered}\n`;
    if (C.incoming) block += `• Incoming: ${C.incoming}\n`;
    if (C.outgoing) block += `• Outgoing: ${C.outgoing}\n`;
    if (C.totalDurationSec > 0) {
      block += `• Talk Time: ${fmtDuration(C.totalDurationSec)}\n`;
      if (C.avgDurationSec > 0) block += `• Avg Duration: ${fmtDuration(C.avgDurationSec)}\n`;
      if (C.maxDurationSec > 0) block += `• Longest Call: ${fmtDuration(C.maxDurationSec)}\n`;
    }
  }

  if (F.due + F.completed + F.pending + F.overdue > 0) {
    block += `\n🔄 <b>FOLLOW-UPS</b>\n`;
    if (F.due)       block += `• Due Today: ${F.due}\n`;
    if (F.completed) block += `• Completed: ${F.completed}\n`;
    if (F.pending)   block += `• Pending: ${F.pending}\n`;
    if (F.overdue)   block += `• Overdue: ${F.overdue}\n`;
  }

  block += `\n────────────────────\n`;
  return block;
}

function buildSummaryBlock(totals, date) {
  const T = totals;
  let block = `\n📈 <b>COMPANY TOTAL</b>\n\n`;
  block += `• Employees Active: ${T.employees}\n`;
  block += `• New Leads: ${T.newLeads}\n`;
  if (T.interested)    block += `• Interested: ${T.interested}\n`;
  if (T.converted)     block += `• Converted: ${T.converted}\n`;
  if (T.notInterested) block += `• Not Interested: ${T.notInterested}\n`;
  if (T.closed)        block += `• Closed: ${T.closed}\n`;
  block += `\n• Total Calls: ${T.calls}\n`;
  block += `• Answered: ${T.answered}\n`;
  block += `• Unanswered: ${T.unanswered}\n`;
  if (T.incoming) block += `• Incoming: ${T.incoming}\n`;
  if (T.outgoing) block += `• Outgoing: ${T.outgoing}\n`;
  if (T.totalDurationSec > 0) {
    block += `• Talk Time: ${fmtDuration(T.totalDurationSec)}\n`;
    if (T.avgDurationSec > 0) block += `• Avg Duration: ${fmtDuration(T.avgDurationSec)}\n`;
    if (T.maxDurationSec > 0) block += `• Longest Call: ${fmtDuration(T.maxDurationSec)}\n`;
  }
  if (T.followUpDue + T.followUpCompleted + T.followUpPending + T.followUpOverdue > 0) {
    block += `\n• Follow-ups Due: ${T.followUpDue}\n`;
    block += `• Follow-ups Completed: ${T.followUpCompleted}\n`;
    block += `• Pending Follow-ups: ${T.followUpPending}\n`;
    if (T.followUpOverdue) block += `• Overdue Follow-ups: ${T.followUpOverdue}\n`;
  }
  return block;
}

/**
 * Splits a long report into multiple ≤4000-char Telegram messages.
 * Returns an array of HTML strings.
 */
function formatTelegramMessages(report, companyName, nurtureStats, waStats, outcomeStats, statusSnap) {
  const header =
    `📊 <b>SKYUP CRM — DAILY SALES REPORT</b>\n` +
    `📅 ${formatDate(report.reportDate)}\n` +
    `🏢 ${escapeHtml(companyName)}\n`;

  const nurtureBlock = buildNurtureBlock(nurtureStats);
  const waBlock      = buildWhatsAppBlock(waStats, nurtureStats?.total || 0);

  if (!report.hasActivity) {
    return [
      header +
      `\n<i>No activity recorded today.</i>\n\n` +
      `• New Leads: 0\n• Calls: 0\n• Answered: 0\n• Conversions: 0` +
      (waBlock      ? `\n${waBlock}`      : '') +
      (nurtureBlock ? `\n${nurtureBlock}` : ''),
    ];
  }

  const messages = [];
  let current = header;

  for (const emp of report.employees) {
    const block = buildEmployeeBlock(emp);
    if ((current + block).length > MAX_MSG_LEN) {
      messages.push(current);
      current = block;
    } else {
      current += block;
    }
  }

  const summary = buildSummaryBlock(report.totals, report.reportDate);
  if ((current + summary).length > MAX_MSG_LEN) {
    messages.push(current);
    current = summary;
  } else {
    current += summary;
  }

  // ── Outcomes block ─────────────────────────────────────────────────────────
  if (outcomeStats && outcomeStats.length > 0) {
    let outBlock = `\n📋 <b>TODAY'S CALL OUTCOMES</b>\n`;
    const outcomeEmoji = {
      'Answered':       '✅',
      'Not Answered':   '📵',
      'Busy':           '📳',
      'Switch Off':     '🔕',
      'Call Back Later':'🔁',
      'Interested':     '🌟',
      'Not Interested': '❌',
      'Invalid':        '🚫',
      'Client Meeting': '🤝',
    };
    for (const { outcome, count } of outcomeStats) {
      const emoji = outcomeEmoji[outcome] || '•';
      outBlock += `${emoji} ${escapeHtml(outcome)}: ${count}\n`;
    }
    outBlock += `\n────────────────────\n`;
    if ((current + outBlock).length > MAX_MSG_LEN) {
      messages.push(current); current = outBlock;
    } else { current += outBlock; }
  }

  // ── Status snapshot block ────────────────────────────────────────────────────
  if (statusSnap && statusSnap.length > 0) {
    let snapBlock = `\n📊 <b>PIPELINE STATUS (All Leads)</b>\n`;
    const statusEmoji = {
      'New':            '🆕',
      'In Progress':    '⏳',
      'Interested':     '🌟',
      'Converted':      '💰',
      'Not Interested': '❌',
    };
    let snapTotal = 0;
    for (const { status, count } of statusSnap) {
      const emoji = statusEmoji[status] || '•';
      snapBlock += `${emoji} ${escapeHtml(status)}: ${count}\n`;
      snapTotal += count;
    }
    snapBlock += `• Total Open: ${snapTotal}\n`;
    snapBlock += `\n────────────────────\n`;
    if ((current + snapBlock).length > MAX_MSG_LEN) {
      messages.push(current); current = snapBlock;
    } else { current += snapBlock; }
  }

  // WhatsApp stats — appended after outcome/status
  if (waBlock) {
    if ((current + waBlock).length > MAX_MSG_LEN) {
      messages.push(current);
      current = waBlock;
    } else {
      current += waBlock;
    }
  }

  // Nurture section — appended after WA stats
  if (nurtureBlock) {
    if ((current + nurtureBlock).length > MAX_MSG_LEN) {
      messages.push(current);
      current = nurtureBlock;
    } else {
      current += nurtureBlock;
    }
  }

  messages.push(current);
  return messages;
}

// ── Low-level Telegram send ───────────────────────────────────────────────────
function sendTelegramMessage(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req  = https.request(
      {
        hostname: 'api.telegram.org',
        path:     `/bot${botToken}/sendMessage`,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed);
            else reject(new Error(`Telegram API error: ${parsed.description || data}`));
          } catch { reject(new Error(`Invalid Telegram response: ${data}`)); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Telegram timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Send report messages to Telegram ─────────────────────────────────────────
async function sendReport(decryptedToken, chatId, messages) {
  const messageIds = [];
  for (const text of messages) {
    const result = await sendTelegramMessage(decryptedToken, chatId, text);
    if (result?.result?.message_id) messageIds.push(result.result.message_id);
    // Small delay between messages to avoid Telegram rate limits
    if (messages.length > 1) await new Promise(r => setTimeout(r, 300));
  }
  return messageIds;
}

// ── Main: generate and send report for one company ───────────────────────────
/**
 * Generates the daily report for a company and sends it to Telegram.
 * Creates a DailyReportHistory record to prevent duplicate sends.
 *
 * @param {Object}  config      - DailyReportConfig document
 * @param {string}  companyName - Company display name
 * @param {string}  [reportDate]- "YYYY-MM-DD" override; defaults to today in company TZ
 * @param {string}  [triggeredBy] - 'scheduler' | 'manual' | 'test'
 * @returns {Object} { sent, skipped, error, messageIds }
 */
// ── WhatsApp sent stats for today ────────────────────────────────────────────
// Counts all outbound WhatsApp messages sent today for the company, broken
// down by: total, template vs free-text, nurture vs auto-template vs manual,
// and inbound replies received.
async function getWhatsAppStats(companyId, dayStart, dayEnd) {
  try {
    // Get all conversations for this company
    const WhatsAppConversation = require('../models/WhatsAppConversation');
    const convIds = await WhatsAppConversation.find(
      { company: new mongoose.Types.ObjectId(String(companyId)) },
      { _id: 1 }
    ).lean().then(docs => docs.map(d => d._id));

    if (!convIds.length) return null;

    const [outbound, inbound] = await Promise.all([
      WhatsAppMessage.aggregate([
        {
          $match: {
            conversation: { $in: convIds },
            direction:    'outbound',
            // Only count successfully sent messages — exclude failed and pending
            status:       { $in: ['sent', 'delivered', 'read'] },
            createdAt:    { $gte: dayStart, $lte: dayEnd },
          },
        },
        {
          $group: {
            _id:           null,
            total:         { $sum: 1 },
            templates:     { $sum: { $cond: [{ $eq: ['$isTemplate', true] }, 1, 0] } },
            freeText:      { $sum: { $cond: [{ $eq: ['$isTemplate', false] }, 1, 0] } },
            delivered:     { $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] } },
            read:          { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
            failed:        { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            // Nurture messages have no sentBy (system-sent)
            nurture:       { $sum: { $cond: [{ $and: [{ $eq: ['$isTemplate', true] }, { $eq: ['$sentBy', null] }] }, 1, 0] } },
            // Agent-sent templates
            agentTemplate: { $sum: { $cond: [{ $and: [{ $eq: ['$isTemplate', true] }, { $ne: ['$sentBy', null] }] }, 1, 0] } },
            // Unique template names used
            templateNames: { $addToSet: '$templateName' },
          },
        },
      ]),
      WhatsAppMessage.countDocuments({
        conversation: { $in: convIds },
        direction:    'inbound',
        createdAt:    { $gte: dayStart, $lte: dayEnd },
      }),
    ]);

    const o = outbound[0] || {};
    return {
      outTotal:      o.total         || 0,
      templates:     o.templates     || 0,
      freeText:      o.freeText      || 0,
      delivered:     o.delivered     || 0,
      read:          o.read          || 0,
      failed:        o.failed        || 0,
      nurture:       o.nurture       || 0,
      agentTemplate: o.agentTemplate || 0,
      inbound:       inbound         || 0,
      templateNames: (o.templateNames || []).filter(Boolean).sort(),
    };
  } catch (err) {
    console.warn('[DailyReport] getWhatsAppStats error:', err.message);
    return null;
  }
}

// ── Build WhatsApp stats block ─────────────────────────────────────────────────
// Only counts SUCCESSFULLY sent messages (status: sent/delivered/read).
// Nurture messages are tracked via nurtureSent on leads (not WhatsAppMessage
// collection) — every nurture send that reaches this point was MSG91 success.
function buildWhatsAppBlock(wa, nurtureTotal) {
  const agentTotal = wa?.outTotal  || 0;
  const grand      = agentTotal + (nurtureTotal || 0);
  if (grand === 0) return '';

  let block = `\n💬 <b>WHATSAPP SENT (Successfully)</b>\n`;
  block    += `• Grand Total:         ${grand}\n`;
  block    += `\n<b>Nurture (Auto):</b>    ${nurtureTotal || 0}\n`;
  if (agentTotal > 0) {
    block  += `<b>Agent Messages:</b>   ${agentTotal}\n`;
    block  += `  · Templates:         ${wa.templates}\n`;
    block  += `  · Free Text:         ${wa.freeText}\n`;
    block  += `  · Delivered:         ${wa.delivered}\n`;
    block  += `  · Read:              ${wa.read}\n`;
    block  += `  · Inbound Replies:   ${wa.inbound}\n`;
  }
  block    += `\n────────────────────\n`;
  return block;
}

// ── Nurture stats for today ───────────────────────────────────────────────────
// Counts nurtureSent[ruleId].lastFiredDate === localDate for each enabled rule.
async function getNurtureStats(companyId, localDate) {
  try {
    const rules = await NurtureRule.find({
      company: new mongoose.Types.ObjectId(String(companyId)),
      enabled: true,
    }).select('name action').lean();

    if (!rules.length) return { rows: [], total: 0 };

    const ruleMap = new Map(rules.map(r => [
      String(r._id),
      {
        name:  r.name,
        stage: r.action?.whatsapp?.funnelStage || r.action?.whatsapp?.statusStage || '—',
      },
    ]));

    const leads = await Lead.find({
      company: new mongoose.Types.ObjectId(String(companyId)),
      nurtureSent: { $exists: true, $ne: {} },
    }).select('nurtureSent').lean();

    const counts = new Map();
    for (const lead of leads) {
      if (!lead.nurtureSent) continue;
      for (const [ruleId, entry] of Object.entries(lead.nurtureSent)) {
        if (!entry || entry.lastFiredDate !== localDate) continue;
        counts.set(ruleId, (counts.get(ruleId) || 0) + 1);
      }
    }

    if (!counts.size) return { rows: [], total: 0 };

    const stageOrder = { awareness: 1, interest: 2, desire: 3, action: 4 };
    const rows = [];
    let total  = 0;

    for (const [ruleId, sent] of counts.entries()) {
      const info = ruleMap.get(ruleId);
      if (!info) continue;
      rows.push({ ruleName: info.name, stage: info.stage, sent });
      total += sent;
    }

    rows.sort((a, b) => {
      const so = (stageOrder[a.stage] || 9) - (stageOrder[b.stage] || 9);
      return so !== 0 ? so : a.ruleName.localeCompare(b.ruleName);
    });

    return { rows, total };
  } catch (err) {
    console.warn('[DailyReport] getNurtureStats error:', err.message);
    return { rows: [], total: 0 };
  }
}

// ── Build nurture block string ─────────────────────────────────────────────────
function buildNurtureBlock(nurtureStats) {
  if (!nurtureStats || !nurtureStats.total) return '';

  const stageEmoji = { awareness: '🌱', interest: '🔍', desire: '💡', action: '🎯' };

  let block = `
📲 <b>NURTURE SEQUENCE</b>
`;
  block    += `• Total Sent Today: <b>${nurtureStats.total}</b>
`;

  const byStage = {};
  for (const row of nurtureStats.rows) {
    if (!byStage[row.stage]) byStage[row.stage] = [];
    byStage[row.stage].push(row);
  }

  for (const [stage, rows] of Object.entries(byStage)) {
    const emoji      = stageEmoji[stage] || '📌';
    const stageTotal = rows.reduce((s, r) => s + r.sent, 0);
    const stageName  = stage.charAt(0).toUpperCase() + stage.slice(1);
    block += `
${emoji} ${stageName}: ${stageTotal}
`;
    for (const row of rows) {
      block += `  · ${escapeHtml(row.ruleName)}: ${row.sent}
`;
    }
  }

  block += `
────────────────────
`;
  return block;
}

async function generateAndSend(config, companyName, reportDate, triggeredBy = 'scheduler') {
  const tz          = config.timezone || 'Asia/Kolkata';
  const localDate   = reportDate || getTodayInTimezone(tz);
  const companyId   = String(config.company);

  // ── Idempotency: check for an existing history record ─────────────────────
  // Prevents duplicate sends from cron overlap / restart / manual re-trigger.
  // 'test' sends always bypass this check.
  if (triggeredBy !== 'test') {
    const existing = await DailyReportHistory.findOne({
      company:     config.company,
      reportDate:  localDate,
      triggeredBy,
      status:      { $in: ['sent', 'pending'] },
    });
    if (existing) {
      console.log(`[DailyReport] Already sent for company ${companyId} date ${localDate} (${triggeredBy}) — skipping`);
      return { sent: false, skipped: true };
    }
  }

  // ── Create a pending history record ───────────────────────────────────────
  let historyDoc;
  try {
    historyDoc = await DailyReportHistory.create({
      company:       config.company,
      reportDate:    localDate,
      scheduledTime: config.reportTime,
      timezone:      tz,
      triggeredBy,
      status:        'pending',
    });
  } catch (err) {
    // Duplicate key = another process beat us to it
    if (err.code === 11000) {
      console.log(`[DailyReport] Race condition — another process already handling ${companyId} ${localDate}`);
      return { sent: false, skipped: true };
    }
    throw err;
  }

  try {
    // ── Generate report ───────────────────────────────────────────────────
    const report       = await buildReport(companyId, config, localDate);
    const nurtureStats  = await getNurtureStats(companyId, localDate);
    const outcomeStats  = await getOutcomeStats(companyId, dayStart, dayEnd);
    const statusSnap    = await getStatusSnapshot(companyId);

    // Get day bounds for WhatsApp query (needs UTC range like other aggregations)
    const { dayStart, dayEnd } = getCompanyDayBounds(config.timezone || 'Asia/Kolkata', localDate);
    const waStats           = await getWhatsAppStats(companyId, dayStart, dayEnd);

    // ── Empty report check ────────────────────────────────────────────────
    if (!report.hasActivity && !config.sendEmptyReport) {
      await DailyReportHistory.findByIdAndUpdate(historyDoc._id, {
        status: 'skipped',
        employeeCount: 0,
      });
      console.log(`[DailyReport] No activity for ${companyId} ${localDate} — skipping (sendEmptyReport=false)`);
      return { sent: false, skipped: true };
    }

    // ── Format messages ───────────────────────────────────────────────────
    const messages = formatTelegramMessages(report, companyName, nurtureStats, waStats, outcomeStats, statusSnap);

    // ── Decrypt token ─────────────────────────────────────────────────────
    const decryptedToken = config.getDecryptedToken();

    // ── Send to Telegram ──────────────────────────────────────────────────
    const messageIds = await sendReport(decryptedToken, config.telegramChatId, messages);

    // ── Update history ────────────────────────────────────────────────────
    await DailyReportHistory.findByIdAndUpdate(historyDoc._id, {
      status:             'sent',
      employeeCount:      report.employees.length,
      telegramMessageIds: messageIds,
    });

    console.log(`[DailyReport] ✅ Sent for company ${companyId} (${companyName}) date ${localDate} — ${messages.length} message(s)`);
    return { sent: true, skipped: false, messageIds };

  } catch (err) {
    // ── Record failure ────────────────────────────────────────────────────
    await DailyReportHistory.findByIdAndUpdate(historyDoc._id, {
      status:       'failed',
      errorMessage: err.message,
    }).catch(() => {});
    console.error(`[DailyReport] ❌ Failed for company ${companyId}:`, err.message);
    return { sent: false, skipped: false, error: err.message };
  }
}

module.exports = {
  generateAndSend,
  buildReport,
  formatTelegramMessages,
  getCompanyDayBounds,
  getTodayInTimezone,
  sendTelegramMessage,
};
