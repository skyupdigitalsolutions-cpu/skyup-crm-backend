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
const { mergeLeadScope } = require('../utils/adminLeadScope');

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
async function getDailyReport({ company, date, userId, campaign, status, excludeClosed = false, leadScope = {} } = {}) {
  if (!company) throw new Error('company is required');

  const { dayStart, dayEnd } = getISTDayBounds(date);

  // ── Base match for today's leads ─────────────────────────────────────────
  const baseMatch = {
    company: new mongoose.Types.ObjectId(company),
    date:    { $gte: dayStart, $lte: dayEnd },
  };
  if (userId)        baseMatch.user     = new mongoose.Types.ObjectId(userId);
  if (campaign)      baseMatch.campaign = campaign;
  if (status)        baseMatch.status   = status;
  // Employees must not see closed leads — admins see everything
  if (excludeClosed) baseMatch.isClosed = { $ne: true };

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
      { $match: mergeLeadScope(baseMatch, leadScope) },
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
          // ── Virtual-status resolution fields ────────────────────────────
          isClosed:    1,
          mergedInto:  1,
          closeReason: 1,
          // ── Project membership ────────────────────────────────────────
          projects:    1,
          assignedUserName: { $arrayElemAt: ['$userInfo.name', 0] },
        },
      },
    ]),

    // Previous day — for trend numbers only
    Lead.aggregate([
      { $match: mergeLeadScope(prevMatch, leadScope) },
      { $group: {
        _id:       null,
        total:     { $sum: 1 },
        converted: { $sum: { $cond: [{ $eq: ['$status', 'Converted'] }, 1, 0] } },
      }},
    ]),

    // Pending follow-ups
    Lead.aggregate([
      { $match: mergeLeadScope({ ...followUpMatch, 'scheduledCalls.done': false }, leadScope) },
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
  // Virtual status counts
  const merged        = todayLeads.filter(l => !!l.mergedInto).length;
  const closed        = todayLeads.filter(l => l.isClosed && !l.mergedInto).length;

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

  // ── Missing follow-up date (24h+ old, NEVER had a scheduledCalls entry) ────
  // Scoped to leads created on the viewed date (same `todayLeads` set as the
  // rest of this report) so admins can flip through past dates and see, for
  // that day's leads, who never got a follow-up scheduled within 24h.
  // Excludes 'Not Interested' (per business rule) and 'Converted' (already won).
  const missingFollowUpCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const missingFollowUps = todayLeads
    .filter(l =>
      !l.mergedInto &&
      !l.isClosed &&
      l.status !== 'Not Interested' &&
      l.status !== 'Converted' &&
      new Date(l.date) <= missingFollowUpCutoff &&
      !(l.scheduledCalls || []).length
    )
    .map(l => ({
      _id:          l._id,
      name:         l.name,
      mobile:       l.mobile,
      status:       l.status,
      assignedUser: l.assignedUserName || 'Unassigned',
      userId:       l.user || null,
      createdAt:    l.date,
      hoursSinceCreated: Math.floor((Date.now() - new Date(l.date).getTime()) / 3600000),
    }))
    .sort((a, b) => b.hoursSinceCreated - a.hoursSinceCreated);

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
      merged,   // virtual: leads with mergedInto set
      closed,   // virtual: leads with isClosed=true and no mergedInto
      missingFollowUpCount: missingFollowUps.length,
    },
    leads:      todayLeads,
    sources,
    employees,
    followUps,
    missingFollowUps,
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
async function getEmployeeReport({ company, fromDate, toDate, userId, leadScope = {} } = {}) {
  if (!company) throw new Error('company is required');

  const { dayStart: from } = getISTDayBounds(fromDate);
  const { dayEnd:   to   } = getISTDayBounds(toDate || fromDate);

  const match = {
    company: new mongoose.Types.ObjectId(company),
    date:    { $gte: from, $lte: to },
  };
  if (userId) match.user = new mongoose.Types.ObjectId(userId);

  const rows = await Lead.aggregate([
    { $match: mergeLeadScope(match, leadScope) },
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
async function getCampaignReport({ company, fromDate, toDate, leadScope = {} } = {}) {
  if (!company) throw new Error('company is required');

  const match = { company: new mongoose.Types.ObjectId(company) };
  if (fromDate || toDate) {
    const { dayStart: from } = getISTDayBounds(fromDate);
    const { dayEnd:   to   } = getISTDayBounds(toDate || fromDate);
    match.date = { $gte: from, $lte: to };
  }

  const rows = await Lead.aggregate([
    { $match: mergeLeadScope(match, leadScope) },
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

// ── getDailyOutcomesReport ────────────────────────────────────────────────────
// Answered / Not Answered breakdown for a given IST calendar day, from TWO
// possible sources:
//
//   1. DEVICE call logs (models/MobileCallLog.js) — synced automatically from
//      the agent's phone by the mobile app. callType + duration come straight
//      from the OS, so this is ground truth: it can't be forgotten, mistyped,
//      or mismarked by an agent. THIS IS THE ACCURATE SOURCE.
//
//   2. MANUAL outcome entries (Lead.callHistory.outcome) — whatever the agent
//      typed into the call-remark box. Useful as a fallback for companies/
//      calls that don't go through the mobile app's call-log sync (e.g. calls
//      logged from the web CRM), but it's self-reported and can be wrong or
//      simply skipped.
//
// FIX (accuracy): the old version only counted the literal string "Answered"
// toward the Answered total. In practice, "Interested", "Not Interested",
// "Client Meeting", and "Call Back Later" all only make sense if the phone
// was actually picked up — those were previously invisible to the Answered
// count, understating the real answer rate. Now classified properly below.
//
// Default behaviour ("auto"): use device logs when the company/day/filters
// actually have any (most accurate); fall back to manual outcomes only when
// there's no device data to look at. The response always says which source
// was used (`usedDataSource`) so the UI can be transparent about it, and both
// raw breakdowns are returned for comparison.
async function getDailyOutcomesReport({
  company,
  date,
  userId,
  source,          // filter: lead.source (e.g. "Meta", "Website", "Manual")
  status,          // filter: lead.status (e.g. "Interested", "Converted")
  campaign,        // filter: lead.campaign (name string — same convention as getDailyReport)
  minDurationSec = 5, // device calls shorter than this don't count as "answered" (accidental pocket dials, instant hangups)
  dataSource = 'auto', // 'auto' | 'device' | 'manual' — force a specific source, or let it pick automatically
  leadScope = {},
} = {}) {
  if (!company) throw new Error('company is required');

  const { dayStart, dayEnd } = getISTDayBounds(date);
  const companyOid = new mongoose.Types.ObjectId(company);

  // Outcome classification — the actual accuracy fix. A call only reaches any
  // of these outcomes because the phone was picked up and a conversation (or
  // at least a clear "no"/"later") happened.
  const ANSWERED_OUTCOMES = new Set([
    'Answered', 'Interested', 'Not Interested', 'Client Meeting', 'Call Back Later',
  ]);
  const NOT_ANSWERED_OUTCOMES = new Set(['Not Answered', 'Busy', 'Switch Off']);
  // 'Invalid' (wrong/junk number) is neither — it's excluded from the answer
  // rate entirely since it was never a real dial attempt at this lead.

  function classify(outcome) {
    if (ANSWERED_OUTCOMES.has(outcome)) return 'answered';
    if (NOT_ANSWERED_OUTCOMES.has(outcome)) return 'notAnswered';
    return 'excluded';
  }

  // Shared lead-level filter fragment (source/status/campaign/agent) used to
  // scope BOTH data sources identically, so switching sources never silently
  // changes which leads are in view.
  const leadFilter = { company: companyOid };
  if (userId) leadFilter.user = new mongoose.Types.ObjectId(userId);
  if (source) leadFilter.source = source;
  if (status) leadFilter.status = status;
  if (campaign) leadFilter.campaign = campaign;
  const scopedLeadFilter = mergeLeadScope(leadFilter, leadScope);

  // ── SOURCE 1: device call logs (ground truth) ───────────────────────────────
  async function buildFromDeviceLogs() {
    const matchStage = {
      company: companyOid,
      timestamp: { $gte: dayStart, $lte: dayEnd },
      callType: { $in: ['incoming', 'outgoing', 'missed', 'voicemail', 'rejected', 'blocked'] },
    };
    if (userId) matchStage.user = new mongoose.Types.ObjectId(userId);

    const pipeline = [
      { $match: matchStage },
      // Only calls that matched a lead in the CRM — otherwise source/status/
      // campaign filters (which live on the Lead) can't be applied, and a
      // stray personal call wouldn't belong in a lead-outcomes report anyway.
      { $match: { matchedLead: { $ne: null } } },
      {
        $lookup: {
          from: 'leads',
          localField: 'matchedLead',
          foreignField: '_id',
          as: 'lead',
        },
      },
      { $unwind: '$lead' },
      // Apply source/status/campaign/scope filters against the joined lead.
      { $match: buildMongoMatchAgainstLeadAlias(scopedLeadFilter, 'lead') },
      {
        $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'agentInfo' },
      },
      {
        $project: {
          leadId:    '$lead._id',
          leadName:  '$lead.name',
          mobile:    '$phoneNumber',
          callType:  1,
          duration:  1,
          calledAt:  '$timestamp',
          agentId:   '$user',
          agentName: { $arrayElemAt: ['$agentInfo.name', 0] },
        },
      },
      { $sort: { calledAt: -1 } },
    ];

    const rows = await MobileCallLog.aggregate(pipeline);

    const calls = rows.map((r) => {
      const answeredByDevice = (r.callType === 'incoming' || r.callType === 'outgoing') && (r.duration || 0) >= minDurationSec;
      const outcome = answeredByDevice
        ? 'Answered'
        : (r.callType === 'missed' ? 'Not Answered'
          : r.callType === 'rejected' ? 'Rejected'
          : r.callType === 'voicemail' ? 'Voicemail'
          : r.callType === 'blocked' ? 'Blocked'
          // incoming/outgoing but under the duration threshold — rang, nobody spoke
          : 'Not Answered');
      return { ...r, outcome, bucket: answeredByDevice ? 'answered' : (outcome === 'Rejected' || outcome === 'Voicemail' || outcome === 'Blocked' ? 'excluded' : 'notAnswered') };
    });

    return { calls, sourceLabel: 'device' };
  }

  // ── SOURCE 2: manual callHistory outcomes (fallback) ────────────────────────
  async function buildFromManualOutcomes() {
    const pipeline = [
      { $match: scopedLeadFilter },
      { $unwind: '$callHistory' },
      { $match: { 'callHistory.calledAt': { $gte: dayStart, $lte: dayEnd } } },
      {
        $lookup: { from: 'users', localField: 'callHistory.userId', foreignField: '_id', as: 'agentInfo' },
      },
      {
        $project: {
          leadId:    '$_id',
          leadName:  '$name',
          mobile:    '$mobile',
          outcome:   { $ifNull: ['$callHistory.outcome', 'Unspecified'] },
          remark:    '$callHistory.remark',
          calledAt:  '$callHistory.calledAt',
          agentId:   '$callHistory.userId',
          agentName: { $ifNull: ['$callHistory.userName', { $arrayElemAt: ['$agentInfo.name', 0] }] },
        },
      },
      { $sort: { calledAt: -1 } },
    ];

    const rows = await Lead.aggregate(pipeline);
    const calls = rows.map((r) => ({ ...r, bucket: classify(r.outcome) }));
    return { calls, sourceLabel: 'manual' };
  }

  let result;
  if (dataSource === 'device') {
    result = await buildFromDeviceLogs();
  } else if (dataSource === 'manual') {
    result = await buildFromManualOutcomes();
  } else {
    // auto: prefer device data; only fall back if there's genuinely nothing there
    const device = await buildFromDeviceLogs();
    result = device.calls.length > 0 ? device : await buildFromManualOutcomes();
  }

  const { calls, sourceLabel } = result;

  // ── Group by outcome (for the breakdown chart) ──────────────────────────────
  const byOutcome = {};
  for (const c of calls) {
    const key = c.outcome || 'Unspecified';
    byOutcome[key] = (byOutcome[key] || 0) + 1;
  }
  const outcomes = Object.entries(byOutcome)
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count);

  // ── Per-agent breakdown ──────────────────────────────────────────────────────
  const byAgent = {};
  for (const c of calls) {
    const key = c.agentId ? String(c.agentId) : 'unassigned';
    if (!byAgent[key]) {
      byAgent[key] = { agentId: c.agentId || null, agentName: c.agentName || 'Unassigned', total: 0, answered: 0, notAnswered: 0, outcomes: {} };
    }
    byAgent[key].total++;
    if (c.bucket === 'answered') byAgent[key].answered++;
    if (c.bucket === 'notAnswered') byAgent[key].notAnswered++;
    byAgent[key].outcomes[c.outcome] = (byAgent[key].outcomes[c.outcome] || 0) + 1;
  }

  const answered      = calls.filter((c) => c.bucket === 'answered').length;
  const notAnswered   = calls.filter((c) => c.bucket === 'notAnswered').length;
  const excluded      = calls.filter((c) => c.bucket === 'excluded').length; // Invalid / rejected / voicemail / blocked — not counted in answer rate
  const countedCalls  = answered + notAnswered; // denominator excludes junk/voicemail/etc.
  const totalCalls    = calls.length;

  return {
    summary: {
      totalCalls,
      answered,
      notAnswered,
      excluded,
      answerRate: countedCalls > 0 ? Math.round((answered / countedCalls) * 100) : 0,
    },
    usedDataSource: sourceLabel, // 'device' (accurate) or 'manual' (self-reported fallback)
    outcomes,
    agents: Object.values(byAgent),
    calls, // raw list for drill-down
    filtersApplied: { userId: userId || null, source: source || null, status: status || null, campaign: campaign || null, minDurationSec, dataSource },
  };
}

// Rewrites a Mongo filter object built for the `leads` collection so it can be
// applied against a joined sub-document alias (e.g. "lead.source" instead of
// "source") after a $lookup + $unwind. Only handles the flat key/value and
// mergeLeadScope's simple $or/$and shapes actually in use here — not a
// general-purpose Mongo query rewriter.
function buildMongoMatchAgainstLeadAlias(filter, alias) {
  const prefix = (key) => (key.startsWith('$') ? key : `${alias}.${key}`);
  const rewriteValue = (v) => {
    if (Array.isArray(v)) return v.map((item) => rewriteObj(item));
    return v;
  };
  const rewriteObj = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$or' || k === '$and' || k === '$nor') {
        out[k] = rewriteValue(v);
      } else {
        out[prefix(k)] = v;
      }
    }
    return out;
  };
  return rewriteObj(filter);
}

module.exports = { getDailyReport, getEmployeeReport, getCampaignReport, getDailyOutcomesReport, getISTDayBounds };
