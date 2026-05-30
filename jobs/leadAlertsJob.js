// jobs/leadAlertsJob.js
// ─────────────────────────────────────────────────────────────────────────────
//  THREE SCHEDULED ALERT TYPES
//
//  1. NEW LEAD NO-ACTION — 1 HOUR
//     Fires: every 15 minutes (cron: */15 * * * *)
//     Trigger: lead assigned, callHistory empty, created between 60–75 min ago,
//              noActionAlert1hSentAt is null (never alerted at 1h threshold).
//     Flow:  admin notified first → super_admin notified second.
//            Sets noActionAlert1hSentAt on the lead so it's never sent again.
//
//  2. NEW LEAD NO-ACTION — 2 HOURS
//     Fires: every 15 minutes (same cron tick as above)
//     Trigger: lead assigned, callHistory empty, created between 120–135 min ago,
//              noActionAlert2hSentAt is null.
//     Flow:  admin notified first → super_admin notified second (🚨 urgency).
//            Sets noActionAlert2hSentAt on the lead so it's never sent again.
//
//  3. FOLLOW-UP DUE ALERT
//     Fires: every day at 9:00 AM
//     Trigger: scheduledCall with done=false and scheduledAt <= today.
//     Flow:  admin notified first → super_admin notified second.
//
//  HOW TO ACTIVATE — already wired in server.js:
//    const { startLeadAlertsJob } = require('./jobs/leadAlertsJob');
//    startLeadAlertsJob();
// ─────────────────────────────────────────────────────────────────────────────

const cron  = require('node-cron');
const Lead  = require('../models/Leads');
const Admin = require('../models/Admin');
const { sendNoActionAlert, sendFollowUpAlert } = require('../services/fcmService');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Group leads by their assignedAdmin. Returns Map<adminIdStr, lead[]> */
function groupByAdmin(leads) {
  const map = new Map();
  for (const lead of leads) {
    const adminId = lead.assignedAdmin ? String(lead.assignedAdmin) : '__unknown__';
    if (!map.has(adminId)) map.set(adminId, []);
    map.get(adminId).push(lead);
  }
  return map;
}

/** All distinct company IDs in a lead list */
function distinctCompanies(leads) {
  return [...new Set(leads.map(l => String(l.company)))];
}

/**
 * Core notify helper — sends to responsible admin then to super_admin.
 * @param {Lead[]} leads     - already populated leads
 * @param {'1h'|'2h'|'daily'} threshold
 */
async function notifyNoAction(leads, threshold) {
  if (!leads.length) return;

  // ── Step 1: notify each responsible admin ──────────────────────────────────
  const byAdmin = groupByAdmin(leads);
  for (const [adminId, adminLeads] of byAdmin) {
    if (adminId === '__unknown__') continue;
    const admin = adminLeads[0].assignedAdmin;
    if (!admin) continue;
    await sendNoActionAlert(admin, adminLeads, threshold);
  }

  // ── Step 2: notify each company's super_admin ──────────────────────────────
  const companyIds = distinctCompanies(leads);
  for (const companyId of companyIds) {
    const superAdmin = await Admin.findOne({ company: companyId, role: 'super_admin' })
      .select('_id name fcmToken role')
      .lean();
    if (!superAdmin) continue;
    const companyLeads = leads.filter(l => String(l.company) === companyId);
    await sendNoActionAlert(superAdmin, companyLeads, threshold);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  JOB 1 & 2 — New Lead No-Action check (runs every 15 minutes)
//
//  Each run checks TWO time windows:
//
//  Window A — 1-hour alert
//    lead.createdAt is between (now - 75 min) and (now - 60 min)
//    AND noActionAlert1hSentAt is null
//
//  Window B — 2-hour alert
//    lead.createdAt is between (now - 135 min) and (now - 120 min)
//    AND noActionAlert2hSentAt is null
//
//  The 15-minute window (60–75 min, 120–135 min) means that however the cron
//  tick falls, every lead is guaranteed to be caught exactly once per threshold.
//  After alerting, the flag is written so it's never resent.
// ─────────────────────────────────────────────────────────────────────────────
async function runNewLeadNoActionCheck() {
  const now = Date.now();

  // ── Window boundaries ─────────────────────────────────────────────────────
  const oneHourAgo      = new Date(now - 60 * 60 * 1000);
  const oneHourPlus     = new Date(now - 75 * 60 * 1000);   // 75 min ago (lower bound)
  const twoHoursAgo     = new Date(now - 120 * 60 * 1000);
  const twoHoursPlus    = new Date(now - 135 * 60 * 1000);  // 135 min ago (lower bound)

  // ── Common query shape (no action taken, assigned, not closed/done) ────────
  const baseQuery = {
    user:        { $ne: null },
    isClosed:    { $ne: true },
    status:      { $nin: ['Not Interested', 'Converted'] },
    callHistory: { $size: 0 },
  };

  try {
    // ── 1-hour window ────────────────────────────────────────────────────────
    const leads1h = await Lead.find({
      ...baseQuery,
      createdAt:            { $lte: oneHourAgo, $gte: oneHourPlus },
      noActionAlert1hSentAt: null,
    })
      .select('_id name mobile company assignedAdmin user status createdAt')
      .populate('user',          'name email')
      .populate('assignedAdmin', 'name email fcmToken role')
      .lean();

    if (leads1h.length > 0) {
      console.log(`[LeadAlertsJob] 1h no-action: ${leads1h.length} lead(s) found`);
      await notifyNoAction(leads1h, '1h');

      // Mark all as alerted so they're never resent at this threshold
      const ids = leads1h.map(l => l._id);
      await Lead.updateMany({ _id: { $in: ids } }, { $set: { noActionAlert1hSentAt: new Date() } });
    }

    // ── 2-hour window ────────────────────────────────────────────────────────
    const leads2h = await Lead.find({
      ...baseQuery,
      createdAt:            { $lte: twoHoursAgo, $gte: twoHoursPlus },
      noActionAlert2hSentAt: null,
    })
      .select('_id name mobile company assignedAdmin user status createdAt')
      .populate('user',          'name email')
      .populate('assignedAdmin', 'name email fcmToken role')
      .lean();

    if (leads2h.length > 0) {
      console.log(`[LeadAlertsJob] 2h no-action: ${leads2h.length} lead(s) found`);
      await notifyNoAction(leads2h, '2h');

      const ids = leads2h.map(l => l._id);
      await Lead.updateMany({ _id: { $in: ids } }, { $set: { noActionAlert2hSentAt: new Date() } });
    }

    if (!leads1h.length && !leads2h.length) {
      // Suppress log noise — only log when something actually fires
    }
  } catch (err) {
    console.error('[LeadAlertsJob] runNewLeadNoActionCheck error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  JOB 3 — Follow-Up Due Alert (runs daily at 9:00 AM)
//  Finds leads with pending scheduledCalls due on or before today.
//  Splits into 'overdue' (past today) and 'due' (today).
// ─────────────────────────────────────────────────────────────────────────────
async function runFollowUpAlerts() {
  try {
    const now        = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(now); todayEnd.setHours(23, 59, 59, 999);

    const leads = await Lead.find({
      isClosed: { $ne: true },
      status:   { $ne: 'Converted' },
      scheduledCalls: {
        $elemMatch: { done: false, scheduledAt: { $lte: todayEnd } },
      },
    })
      .select('_id name mobile company assignedAdmin user status scheduledCalls')
      .populate('user',          'name email')
      .populate('assignedAdmin', 'name email fcmToken role')
      .lean();

    if (leads.length === 0) {
      console.log('[LeadAlertsJob] Follow-up check: 0 leads qualify.');
      return;
    }

    const overdueLeads  = [];
    const dueTodayLeads = [];

    for (const lead of leads) {
      const pendingDates = lead.scheduledCalls
        .filter(sc => !sc.done)
        .map(sc => new Date(sc.scheduledAt))
        .sort((a, b) => a - b);
      if (!pendingDates.length) continue;

      const earliest = pendingDates[0];
      if (earliest < todayStart) overdueLeads.push(lead);
      else                       dueTodayLeads.push(lead);
    }

    console.log(`[LeadAlertsJob] Follow-up: ${overdueLeads.length} overdue, ${dueTodayLeads.length} due today.`);

    for (const [bucket, type] of [[overdueLeads, 'overdue'], [dueTodayLeads, 'due']]) {
      if (!bucket.length) continue;

      const byAdmin = groupByAdmin(bucket);
      for (const [adminId, adminLeads] of byAdmin) {
        if (adminId === '__unknown__') continue;
        const admin = adminLeads[0].assignedAdmin;
        if (!admin) continue;
        await sendFollowUpAlert(admin, adminLeads, type);
      }

      const companyIds = distinctCompanies(bucket);
      for (const companyId of companyIds) {
        const superAdmin = await Admin.findOne({ company: companyId, role: 'super_admin' })
          .select('_id name fcmToken role')
          .lean();
        if (!superAdmin) continue;
        const companyLeads = bucket.filter(l => String(l.company) === companyId);
        await sendFollowUpAlert(superAdmin, companyLeads, type);
      }
    }
  } catch (err) {
    console.error('[LeadAlertsJob] runFollowUpAlerts error:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function startLeadAlertsJob() {
  // New lead no-action check — every 15 minutes around the clock
  // Catches leads at their 1-hour and 2-hour marks precisely
  cron.schedule('*/15 * * * *', () => {
    runNewLeadNoActionCheck();
  });

  // Follow-up due alerts — once a day at 9:00 AM
  cron.schedule('0 9 * * *', () => {
    console.log('[LeadAlertsJob] Running follow-up due alerts...');
    runFollowUpAlerts();
  });

  console.log('[LeadAlertsJob] ✅ Lead alert jobs started');
  console.log('  → New lead no-action: every 15 min (alerts at 1h and 2h marks)');
  console.log('  → Follow-up due:      daily at 9:00 AM');
}

module.exports = { startLeadAlertsJob, runFollowUpAlerts, runNewLeadNoActionCheck };
