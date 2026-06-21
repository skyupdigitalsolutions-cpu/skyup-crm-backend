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
//  HOW TO ACTIVATE — already wired in server.js:
//    const { startLeadAlertsJob } = require('./jobs/leadAlertsJob');
//    startLeadAlertsJob();
// ─────────────────────────────────────────────────────────────────────────────

const cron  = require('node-cron');
const Lead  = require('../models/Leads');
const Admin = require('../models/Admin');
const { sendNoActionAlert, sendFollowUpAlert, sendEscalationAlert } = require('../services/fcmService');

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

  for (const companyId of companyIds) {
    const superAdmin = await Admin.findOne({ company: companyId, role: 'super_admin' })
      .select('_id name fcmToken role')
      .lean();
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

    const adminIds = await Admin.find({ role: 'admin' })
      .select('_id')
      .lean()
      .then(docs => docs.map(d => d._id));

    const leads = await Lead.find({
      isClosed:       { $ne: true },
      status:         { $ne: 'Converted' },
      assignedAdmin:  { $in: adminIds },
      scheduledCalls: { $elemMatch: { done: false, scheduledAt: { $lte: todayEnd } } },
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
      if (pendingDates[0] < todayStart) overdueLeads.push(lead);
      else                              dueTodayLeads.push(lead);
    }

    console.log(`[LeadAlertsJob] Follow-up: ${overdueLeads.length} overdue, ${dueTodayLeads.length} due today.`);

    for (const [bucket, type] of [[overdueLeads, 'overdue'], [dueTodayLeads, 'due']]) {
      if (!bucket.length) continue;
      const byAdmin = groupByAdmin(bucket);
      for (const [adminId, adminLeads] of byAdmin) {
        if (adminId === '__unknown__') continue;
        const admin = adminLeads[0].assignedAdmin;
        if (!admin || !admin._id) continue;
        if (admin.role === 'super_admin') continue;
        await sendFollowUpAlert(admin, adminLeads, type);
      }
    }
  } catch (err) {
    console.error('[LeadAlertsJob] runFollowUpAlerts error:', err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function startLeadAlertsJob() {
  // No-action + escalation check — every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    runNewLeadNoActionCheck();
  });

  // Follow-up due alerts — once a day at 9:00 AM
  cron.schedule('0 9 * * *', () => {
    console.log('[LeadAlertsJob] Running follow-up due alerts...');
    runFollowUpAlerts();
  });

  console.log('[LeadAlertsJob] ✅ Lead alert jobs started');
  console.log('  → No-action (admin 1h + 2h, super_admin 3h escalation): every 15 min');
  console.log('  → Follow-up due (admin only):                            daily at 9:00 AM');
}

module.exports = { startLeadAlertsJob, runFollowUpAlerts, runNewLeadNoActionCheck };
