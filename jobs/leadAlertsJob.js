// jobs/leadAlertsJob.js
// ─────────────────────────────────────────────────────────────────────────────
//  FOUR SCHEDULED ALERT TYPES
//
//  1. NEW LEAD NO-ACTION — 1 HOUR
//     Fires: every 15 minutes (cron: */15 * * * *)
//     Trigger: lead assigned to admin, callHistory empty, created 60–75 min ago,
//              noActionAlert1hSentAt is null.
//     Recipients: assignedAdmin only.
//
//  2. NEW LEAD NO-ACTION — 2 HOURS
//     Fires: every 15 minutes
//     Trigger: lead assigned to admin, callHistory empty, created 120–135 min ago,
//              noActionAlert2hSentAt is null.
//     Recipients: assignedAdmin only.
//
//  3. SUPER_ADMIN ESCALATION — 3 HOURS
//     Fires: every 15 minutes
//     Trigger: lead's noActionAlert2hSentAt is set (admin was warned at 2h)
//              AND callHistory is still empty (admin took NO action after warning)
//              AND lead is 180–195 min old
//              AND noActionAlertSuperAdminSentAt is null (not yet escalated).
//     Recipients: company's super_admin only.
//     Message clearly states which admin failed to act and on which leads.
//
//  4. FOLLOW-UP DUE ALERT
//     Fires: every day at 9:00 AM
//     Trigger: scheduledCall with done=false and scheduledAt <= today.
//     Recipients: assignedAdmin only (scoped to their own leads).
//
//  5. MISSING FOLLOW-UP DATE ALERT
//     Fires: every 15 minutes
//     Trigger: lead is 24h+ old, has ZERO scheduledCalls entries ever (no
//              follow-up date ever set), status not 'Not Interested' or
//              'Converted', not closed/merged. Re-fires every 24h until the
//              employee finally schedules one.
//     Recipients: the lead's assigned EMPLOYEE (User, not Admin).
//
//  HOW TO ACTIVATE — already wired in server.js:
//    const { startLeadAlertsJob } = require('./jobs/leadAlertsJob');
//    startLeadAlertsJob();
// ─────────────────────────────────────────────────────────────────────────────

const cron  = require('node-cron');
const Lead  = require('../models/Leads');
const Admin = require('../models/Admin');
const User  = require('../models/Users');
const { sendNoActionAlert, sendFollowUpAlert, sendEscalationAlert, sendNoFollowUpAlert } = require('../services/fcmService');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Group leads by their assignedAdmin._id string.
 * Returns Map<adminIdStr, lead[]>
 */
function groupByAdmin(leads) {
  const map = new Map();
  for (const lead of leads) {
    const adminId = lead.assignedAdmin?._id
      ? String(lead.assignedAdmin._id)
      : lead.assignedAdmin
        ? String(lead.assignedAdmin)
        : '__unknown__';
    if (!map.has(adminId)) map.set(adminId, []);
    map.get(adminId).push(lead);
  }
  return map;
}

/** All distinct company IDs in a lead list */
function distinctCompanies(leads) {
  return [...new Set(leads.map(l => String(l.company)))];
}

// ─────────────────────────────────────────────────────────────────────────────
//  notifyAdminNoAction — sends ONLY to each lead's responsible admin.
//  super_admin is intentionally excluded here.
// ─────────────────────────────────────────────────────────────────────────────
async function notifyAdminNoAction(leads, threshold) {
  if (!leads.length) return;

  const byAdmin = groupByAdmin(leads);
  for (const [adminId, adminLeads] of byAdmin) {
    if (adminId === '__unknown__') continue;
    const admin = adminLeads[0].assignedAdmin;
    if (!admin || !admin._id) continue;
    if (admin.role === 'super_admin') continue;
    await sendNoActionAlert(admin, adminLeads, threshold);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  notifySuperAdminEscalation — sends ONLY to the company super_admin.
//  Called when admin was already warned at 1h + 2h but still took no action.
//  Groups leads by the admin who failed to act so the super_admin knows
//  exactly which admin is responsible.
// ─────────────────────────────────────────────────────────────────────────────
async function notifySuperAdminEscalation(leads) {
  if (!leads.length) return;

  // Group by company first so we find the right super_admin per company
  const companyIds = distinctCompanies(leads);

  // FIX: previously `await Admin.findOne(...)` INSIDE the for-loop — one
  // round trip per company with an escalation this tick. Batch-fetch every
  // company's super_admin in one query instead.
  const superAdmins = await Admin.find(
    { company: { $in: companyIds }, role: 'super_admin' },
    { name: 1, fcmToken: 1, role: 1, company: 1 },
  ).lean();
  const superAdminMap = new Map(superAdmins.map(a => [String(a.company), a]));

  for (const companyId of companyIds) {
    const superAdmin = superAdminMap.get(companyId);
    if (!superAdmin) continue;

    const companyLeads = leads.filter(l => String(l.company) === companyId);

    // Build a breakdown of which admin has how many unactioned leads
    // so the super_admin can see at a glance who to follow up with
    const byAdmin = groupByAdmin(companyLeads);
    const adminBreakdown = [];
    for (const [adminId, adminLeads] of byAdmin) {
      if (adminId === '__unknown__') continue;
      const adminDoc = adminLeads[0].assignedAdmin;
      adminBreakdown.push({
        adminName: adminDoc?.name || 'Unknown Admin',
        adminId,
        count: adminLeads.length,
        leads: adminLeads,
      });
    }

    await sendEscalationAlert(superAdmin, adminBreakdown, companyLeads.length);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  JOB 1 & 2 — New Lead No-Action check (runs every 15 minutes)
//  Also runs the 3h super_admin escalation check in the same tick.
// ─────────────────────────────────────────────────────────────────────────────
async function runNewLeadNoActionCheck() {
  const now = Date.now();

  // NOTE: only UPPER bounds are used now. The lower bounds (…Plus) previously
  // limited each tier to a ~15-minute slice of a lead's life, so a lead that
  // missed its exact window (or that the 15-min cron tick skipped over) was
  // never alerted. The `noActionAlert{1,2}hSentAt` / SuperAdmin guards already
  // prevent duplicate alerts, so we can safely match ANY still-unactioned lead
  // older than each threshold and let the guard dedup.
  const oneHourAgo      = new Date(now - 60  * 60 * 1000);
  const twoHoursAgo     = new Date(now - 120 * 60 * 1000);
  const threeHoursAgo   = new Date(now - 180 * 60 * 1000);

  // Only fetch leads assigned to regular admins
  const adminIds = await Admin.find({ role: 'admin' })
    .select('_id')
    .lean()
    .then(docs => docs.map(d => d._id));

  const baseQuery = {
    user:          { $ne: null },
    isClosed:      { $ne: true },
    status:        { $nin: ['Not Interested', 'Converted'] },
    callHistory:   { $size: 0 },
    assignedAdmin: { $in: adminIds },
  };

  try {
    // ── 1-hour window — notify admin ─────────────────────────────────────────
    const leads1h = await Lead.find({
      ...baseQuery,
      createdAt:             { $lte: oneHourAgo },
      noActionAlert1hSentAt: null,
    })
      .select('_id name mobile company assignedAdmin user status createdAt')
      .populate('user',          'name email')
      .populate('assignedAdmin', 'name email fcmToken role')
      .lean();

    if (leads1h.length > 0) {
      console.log(`[LeadAlertsJob] 1h no-action: ${leads1h.length} lead(s) — notifying admin(s)`);
      await notifyAdminNoAction(leads1h, '1h');
      await Lead.updateMany(
        { _id: { $in: leads1h.map(l => l._id) } },
        { $set: { noActionAlert1hSentAt: new Date() } }
      );
    }

    // ── 2-hour window — notify admin ─────────────────────────────────────────
    const leads2h = await Lead.find({
      ...baseQuery,
      createdAt:             { $lte: twoHoursAgo },
      noActionAlert2hSentAt: null,
    })
      .select('_id name mobile company assignedAdmin user status createdAt')
      .populate('user',          'name email')
      .populate('assignedAdmin', 'name email fcmToken role')
      .lean();

    if (leads2h.length > 0) {
      console.log(`[LeadAlertsJob] 2h no-action: ${leads2h.length} lead(s) — notifying admin(s)`);
      await notifyAdminNoAction(leads2h, '2h');
      await Lead.updateMany(
        { _id: { $in: leads2h.map(l => l._id) } },
        { $set: { noActionAlert2hSentAt: new Date() } }
      );
    }

    // ── 3-hour escalation window — notify super_admin ─────────────────────────
    // Conditions:
    //   • Lead is 180–195 min old (3h window)
    //   • callHistory is still empty (admin took NO action)
    //   • noActionAlert2hSentAt is NOT null (admin was already warned at 2h)
    //   • noActionAlertSuperAdminSentAt is null (super_admin not yet notified)
    const leads3h = await Lead.find({
      ...baseQuery,                           // callHistory: {$size:0} still applies
      createdAt:                    { $lte: threeHoursAgo },
      noActionAlert2hSentAt:        { $ne: null },   // admin was warned at 2h
      noActionAlertSuperAdminSentAt: null,            // super_admin not yet escalated
    })
      .select('_id name mobile company assignedAdmin user status createdAt noActionAlert2hSentAt')
      .populate('user',          'name email')
      .populate('assignedAdmin', 'name email fcmToken role')
      .lean();

    if (leads3h.length > 0) {
      console.log(`[LeadAlertsJob] 3h escalation: ${leads3h.length} lead(s) — notifying super_admin(s)`);
      await notifySuperAdminEscalation(leads3h);
      await Lead.updateMany(
        { _id: { $in: leads3h.map(l => l._id) } },
        { $set: { noActionAlertSuperAdminSentAt: new Date() } }
      );
    }

  } catch (err) {
    console.error('[LeadAlertsJob] runNewLeadNoActionCheck error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  JOB 4 — Follow-Up Due Alert (runs daily at 9:00 AM)
//  Each admin receives alerts only for their own assigned leads.
//  super_admin is excluded from follow-up alerts.
// ─────────────────────────────────────────────────────────────────────────────
async function runFollowUpAlerts() {
  try {
    const now        = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(now); todayEnd.setHours(23, 59, 59, 999);

    // Query all leads with a pending follow-up due today or overdue
    // No longer filtering by assignedAdmin — also picks up employee-assigned leads
    const leads = await Lead.find({
      isClosed:       { $ne: true },
      status:         { $ne: 'Converted' },
      mergedInto:     null,
      scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $lte: todayEnd } } },
    })
      .select('_id name mobile company assignedAdmin user status scheduledCalls')
      .populate('user',          'name email fcmToken')   // employee assigned to lead
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
      if (pendingDates[0] < todayStart) overdueLeads.push(lead);
      else                              dueTodayLeads.push(lead);
    }

    console.log(`[LeadAlertsJob] Follow-up: ${overdueLeads.length} overdue, ${dueTodayLeads.length} due today.`);

    for (const [bucket, type] of [[overdueLeads, 'overdue'], [dueTodayLeads, 'due']]) {
      if (!bucket.length) continue;

      // ── 1. Alert admins (grouped by assignedAdmin) ──────────────────────────
      const byAdmin = groupByAdmin(bucket);
      for (const [adminId, adminLeads] of byAdmin) {
        if (adminId === '__unknown__') continue;
        const admin = adminLeads[0].assignedAdmin;
        if (!admin || !admin._id) continue;
        if (admin.role === 'super_admin') continue;
        await sendFollowUpAlert(admin, adminLeads, type);
      }

      // ── 2. Alert employees (grouped by lead.user) ───────────────────────────
      // Each employee gets alerted only about their own assigned leads.
      // This is the KEY FIX — previously employees never got this alert.
      const byUser = new Map();
      for (const lead of bucket) {
        if (!lead.user?._id) continue;
        const uid = String(lead.user._id);
        if (!byUser.has(uid)) byUser.set(uid, []);
        byUser.get(uid).push(lead);
      }

      // Fetch User docs for fcmToken (populate already fetched name/email/fcmToken)
      for (const [userId, userLeads] of byUser) {
        const user = userLeads[0].user;
        if (!user || !user._id) continue;
        // Use sendFollowUpAlert — it works for any recipient with _id + fcmToken
        // Socket room for employees uses 'agent:userId' prefix
        await sendFollowUpAlertToEmployee(user, userLeads, type);
      }
    }
  } catch (err) {
    console.error('[LeadAlertsJob] runFollowUpAlerts error:', err.message);
  }
}

// ── Send follow-up alert to an employee (User role) ───────────────────────────
// Mirrors sendFollowUpAlert but uses the 'agent' socket room instead of 'admin'.
async function sendFollowUpAlertToEmployee(user, leads, type) {
  try {
    const { sendFollowUpAlert } = require('../services/fcmService');
    const count     = leads.length;
    const isOverdue = type === 'overdue';

    // ── Socket alert ─────────────────────────────────────────────────────────
    const _io = global._io;
    if (_io && user._id) {
      _io.to(`agent:${user._id}`).emit('follow_up_alert', {
        type,
        count,
        leads: leads.map(l => ({ leadId: String(l._id), leadName: l.name })),
        timestamp: new Date().toISOString(),
      });
    }

    // ── FCM push notification ─────────────────────────────────────────────────
    if (user.fcmToken) {
      // Pass user with role='user' so sendFollowUpAlert uses correct socket room
      await sendFollowUpAlert({ ...user, role: 'user' }, leads, type);
    }

    console.log(`[LeadAlertsJob] Follow-up alert (${type}) → employee "${user.name}" — ${count} lead(s)`);
  } catch (err) {
    console.error('[LeadAlertsJob] sendFollowUpAlertToEmployee error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  JOB 5 — Missing Follow-Up Date Alert (runs every 15 minutes)
//
//  Trigger: lead created 24h+ ago, has NEVER had a single scheduledCalls entry
//           (of any type) added — i.e. the employee never picked a follow-up
//           date — AND status is not 'Not Interested' or 'Converted', AND the
//           lead isn't closed/merged.
//  Recipient: the lead's assigned EMPLOYEE (User, not Admin) via FCM push +
//             socket (room `agent:<userId>`) — reuses sendNewLeadNotification's
//             delivery pattern.
//  Re-fires every 24h per lead (via noFollowUpAlertLastSentAt) until the
//  employee finally schedules a follow-up, at which point the query naturally
//  stops matching that lead.
// ─────────────────────────────────────────────────────────────────────────────
async function runNoFollowUpDateCheck() {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const leads = await Lead.find({
      user:       { $ne: null },
      mergedInto: null,
      isClosed:   { $ne: true },
      status:     { $nin: ['Not Interested', 'Converted'] },
      date:       { $lte: twentyFourHoursAgo },
      // Never had ANY scheduledCalls entry at all — "no follow-up date ever set"
      'scheduledCalls.0': { $exists: false },
      // Re-fire every 24h: never alerted, or last alert was 24h+ ago
      $or: [
        { noFollowUpAlertLastSentAt: null },
        { noFollowUpAlertLastSentAt: { $lte: twentyFourHoursAgo } },
      ],
    })
      .select('_id name mobile company user status date')
      .lean();

    if (!leads.length) {
      console.log('[LeadAlertsJob] No-follow-up-date check: 0 lead(s) due.');
      return;
    }

    // Group by assigned employee so each gets ONE notification, not one per lead
    const byUser = new Map();
    for (const lead of leads) {
      const uid = String(lead.user);
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid).push(lead);
    }

    console.log(`[LeadAlertsJob] No-follow-up-date: ${leads.length} lead(s) across ${byUser.size} employee(s).`);

    // FIX: this used to do `await User.findById(userId)` INSIDE the loop —
    // one DB round trip per employee with an overdue lead, every time this
    // job runs. Batch-fetch every employee in the group in one query instead.
    const users = await User.find(
      { _id: { $in: [...byUser.keys()] } },
      { name: 1, fcmToken: 1 },
    ).lean();
    const userMap = new Map(users.map(u => [String(u._id), u]));

    for (const [userId, userLeads] of byUser) {
      const user = userMap.get(userId);
      if (!user) continue;

      await sendNoFollowUpAlert(user, userLeads);

      await Lead.updateMany(
        { _id: { $in: userLeads.map(l => l._id) } },
        { $set: { noFollowUpAlertLastSentAt: new Date() } }
      );
    }
  } catch (err) {
    console.error('[LeadAlertsJob] runNoFollowUpDateCheck error:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function startLeadAlertsJob() {
  // No-action + escalation check — every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    runNewLeadNoActionCheck();
  });

  // Missing follow-up date check (employee nudge) — every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    runNoFollowUpDateCheck();
  });

  // Follow-up due alerts — once a day at 9:30 AM IST
  // Sends to BOTH admins AND employees so everyone knows their follow-ups for the day.
  cron.schedule('30 9 * * *', () => {
    console.log('[LeadAlertsJob] Running follow-up due alerts (9:30 AM)...');
    runFollowUpAlerts();
  }, { timezone: 'Asia/Kolkata' });

  console.log('[LeadAlertsJob] ✅ Lead alert jobs started');
  console.log('  → No-action (admin 1h + 2h, super_admin 3h escalation): every 15 min');
  console.log('  → Missing follow-up date (employee, 24h+, re-fires 24h): every 15 min');
  console.log('  → Follow-up due (admin + employee):                      daily at 9:30 AM IST');
}

module.exports = {
  startLeadAlertsJob,
  runFollowUpAlerts,
  runNewLeadNoActionCheck,
  runNoFollowUpDateCheck,
};
