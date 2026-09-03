// services/fcmService.js
// ─────────────────────────────────────────────────────────────────────────────
//  FCM PUSH NOTIFICATION SERVICE
//
//  ── One-time setup ───────────────────────────────────────────────────────────
//  1. npm install firebase-admin
//  2. Go to Firebase Console → Project Settings → Service Accounts
//     → Generate new private key  → save the JSON file
//  3. Set this env var on your server / Render dashboard:
//
//       FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
//
//     Paste the ENTIRE contents of the downloaded JSON as the value.
//     Alternatively set GOOGLE_APPLICATION_CREDENTIALS to the absolute path
//     of the JSON file (local dev only — Render uses the JSON string approach).
//
//  FIX BUG 3: The previous implementation silently returned null when credentials
//  were missing, making it impossible to distinguish "FCM configured but broken"
//  from "FCM never configured". Every sendNewLeadNotification call would silently
//  no-op without any visible error after the initial startup warn.
//
//  New behaviour:
//    • On startup, immediately try to initialise Firebase Admin.
//    • If credentials are missing: log a clear WARNING (not a crash — the server
//      can still run for non-FCM features). _initFailed is set so every send
//      call logs a visible per-call warning instead of silently returning.
//    • Call checkFCMHealth() from server.js during startup to surface the
//      problem clearly in the logs before any HTTP traffic starts.
// ─────────────────────────────────────────────────────────────────────────────

const User  = require('../models/Users');
const Admin = require('../models/Admin');

// ── Lazy Firebase init ────────────────────────────────────────────────────────
let _messaging  = null;
let _initFailed = false;
let _initError  = null;   // store the reason so per-send logs are useful

function getMessaging() {
  if (_messaging)  return _messaging;
  if (_initFailed) return null;

  try {
    const admin = require('firebase-admin');

    if (!admin.apps.length) {
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

      if (serviceAccountJson) {
        let parsed;
        try {
          parsed = JSON.parse(serviceAccountJson);
        } catch (parseErr) {
          _initError  = `FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${parseErr.message}`;
          _initFailed = true;
          console.error('[FCM] ❌', _initError);
          return null;
        }

        admin.initializeApp({
          credential: admin.credential.cert(parsed),
        });
        console.log('[FCM] ✅ Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON');

      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        });
        console.log('[FCM] ✅ Firebase Admin initialized from GOOGLE_APPLICATION_CREDENTIALS');

      } else {
        _initError = (
          'Neither FIREBASE_SERVICE_ACCOUNT_JSON nor GOOGLE_APPLICATION_CREDENTIALS is set.\n' +
          '  → Push notifications are DISABLED.\n' +
          '  → Set FIREBASE_SERVICE_ACCOUNT_JSON in your Render environment variables.\n' +
          '  → Value = entire contents of the Firebase service account JSON file.'
        );
        _initFailed = true;
        console.error('[FCM] ❌', _initError);
        return null;
      }
    }

    _messaging = admin.messaging();
    return _messaging;
  } catch (err) {
    _initError  = err.message;
    _initFailed = true;
    console.error('[FCM] ❌ Firebase Admin init failed:', err.message);
    return null;
  }
}

// ── Health check — call this from server.js after connectDB() ─────────────────
// Prints a clear startup message so the problem is visible in Render logs
// without having to wait for the first notification attempt.
//
// Usage in server.js (add after startSubscriptionExpiryJob()):
//   const { checkFCMHealth } = require('./services/fcmService');
//   checkFCMHealth();
function checkFCMHealth() {
  const m = getMessaging();
  if (m) {
    console.log('[FCM] ✅ Health check passed — push notifications are active.');
  } else {
    console.error(
      '[FCM] ❌ Health check FAILED — push notifications will not be sent.\n' +
      '  Reason:', _initError || 'unknown'
    );
  }
}

// ── Clear a stale token from the DB ──────────────────────────────────────────
async function clearStaleToken(userId) {
  await User.findByIdAndUpdate(userId, { $set: { fcmToken: null } }).catch(() => {});
  console.warn(`[FCM] Cleared stale FCM token for user ${userId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  sendNewLeadNotification(userId, lead)
//  Called when a NEW lead is created and assigned to an agent.
// ─────────────────────────────────────────────────────────────────────────────
async function sendNewLeadNotification(userId, lead) {
  const messaging = getMessaging();
  if (!messaging) {
    if (_initFailed) {
      console.warn('[FCM] sendNewLeadNotification skipped — FCM not initialised:', _initError);
    }
    return;
  }

  try {
    const user = await User.findById(userId).select('fcmToken name').lean();
    if (!user?.fcmToken) {
      console.warn(`[FCM] sendNewLeadNotification: user ${userId} has no fcmToken — mobile app may not have registered yet`);
      return;
    }

    const leadName   = lead.name   || 'New Lead';
    const leadSource = lead.source || 'Web Form';
    const campaign   = lead.campaign ? ` · ${lead.campaign}` : '';

    await messaging.send({
      token: user.fcmToken,
      notification: {
        title: '📋 New Lead Assigned',
        body:  `${leadName} — ${leadSource}${campaign}`,
      },
      data: {
        type:       'new_lead',
        leadId:     String(lead._id),
        leadName:   leadName,
        leadMobile: lead.mobile   || '',
        leadSource: leadSource,
        campaign:   lead.campaign || '',
        status:     lead.status   || 'New',
      },
      android: {
        priority: 'high',
        notification: {
          channelId:             'new_lead_channel_v2',
          priority:              'max',
          defaultSound:          true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title: '📋 New Lead Assigned', body: `${leadName} — ${leadSource}${campaign}` },
            sound: 'default',
            badge: 1,
            'content-available': 1,
          },
        },
        headers: { 'apns-priority': '10' },
      },
    });

    console.log(`[FCM] ✅ Push sent to "${user.name}" for lead "${leadName}"`);
  } catch (err) {
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      await clearStaleToken(userId);
    } else {
      console.error('[FCM] sendNewLeadNotification error:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  sendReassignedLeadNotification(userId, lead)
//  Called when a lead is REASSIGNED to a different agent.
// ─────────────────────────────────────────────────────────────────────────────
async function sendReassignedLeadNotification(userId, lead) {
  const messaging = getMessaging();
  if (!messaging) {
    if (_initFailed) {
      console.warn('[FCM] sendReassignedLeadNotification skipped — FCM not initialised:', _initError);
    }
    return;
  }

  try {
    const user = await User.findById(userId).select('fcmToken name').lean();
    if (!user?.fcmToken) {
      console.warn(`[FCM] sendReassignedLeadNotification: user ${userId} has no fcmToken`);
      return;
    }

    const leadName = lead.name || 'Lead';

    await messaging.send({
      token: user.fcmToken,
      notification: {
        title: '🔄 Lead Reassigned to You',
        body:  `${leadName} has been assigned to you`,
      },
      data: {
        type:       'reassigned_lead',
        leadId:     String(lead._id),
        leadName:   leadName,
        leadMobile: lead.mobile   || '',
        leadSource: lead.source   || '',
        campaign:   lead.campaign || '',
        status:     lead.status   || '',
      },
      android: {
        priority: 'high',
        notification: {
          channelId:             'new_lead_channel_v2',
          priority:              'max',
          defaultSound:          true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title: '🔄 Lead Reassigned to You', body: `${leadName} has been assigned to you` },
            sound: 'default',
            badge: 1,
            'content-available': 1,
          },
        },
        headers: { 'apns-priority': '10' },
      },
    });

    console.log(`[FCM] ✅ Reassign push sent to "${user.name}" for lead "${leadName}"`);
  } catch (err) {
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      await clearStaleToken(userId);
    } else {
      console.error('[FCM] sendReassignedLeadNotification error:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  notifySuperAdminReassignment(companyId, { lead, fromAdminName, toUserName, reason })
//
//  Called by adminUpdateLead whenever an admin manually reassigns a lead to a
//  different employee.  Finds the super_admin of the company and notifies via:
//    1. Socket.IO  → room  "superadmin:<superAdminId>"  (instant in-app)
//    2. FCM push   → Admin.fcmToken  (mobile / background tab)
// ─────────────────────────────────────────────────────────────────────────────
async function notifySuperAdminReassignment(companyId, { lead, fromAdminName, toUserName, reason }) {
  try {
    // Find the super_admin for this company
    const superAdmin = await Admin.findOne({ company: companyId, role: 'super_admin' })
      .select('_id name fcmToken')
      .lean();
    if (!superAdmin) return; // No super_admin configured — silently skip

    const leadName   = lead.name   || 'Lead';
    const reasonText = reason      ? ` — Reason: ${reason}` : '';
    const body       = `${leadName} reassigned from ${fromAdminName} to ${toUserName}${reasonText}`;

    // ── 1. Socket push ────────────────────────────────────────────────────────
    const _io = global._io;
    if (_io) {
      _io.to(`superadmin:${superAdmin._id}`).emit('lead_reassigned_notify', {
        leadId:        String(lead._id),
        leadName,
        fromAdminName,
        toUserName,
        reason:        reason || '',
        timestamp:     new Date().toISOString(),
      });
    }

    // ── 2. FCM push ───────────────────────────────────────────────────────────
    const messaging = getMessaging();
    if (!messaging || !superAdmin.fcmToken) return;

    await messaging.send({
      token: superAdmin.fcmToken,
      notification: {
        title: '🔄 Lead Reassigned',
        body,
      },
      data: {
        type:          'lead_reassigned_notify',
        leadId:        String(lead._id),
        leadName,
        fromAdminName,
        toUserName,
        reason:        reason || '',
      },
      android: {
        priority: 'high',
        notification: {
          channelId:             'new_lead_channel_v2',
          priority:              'max',
          defaultSound:          true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title: '🔄 Lead Reassigned', body },
            sound: 'default',
            badge: 1,
            'content-available': 1,
          },
        },
        headers: { 'apns-priority': '10' },
      },
    });

    console.log(`[FCM] ✅ Reassign alert sent to super_admin "${superAdmin.name}" for lead "${leadName}"`);
  } catch (err) {
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      await Admin.findByIdAndUpdate(
        (await Admin.findOne({ company: companyId, role: 'super_admin' }).select('_id').lean())?._id,
        { $set: { fcmToken: null } }
      ).catch(() => {});
      console.warn('[FCM] Cleared stale FCM token for super_admin');
    } else {
      console.error('[FCM] notifySuperAdminReassignment error:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  sendNoActionAlert(recipient, leads, threshold)
//
//  Notifies an admin or superadmin that certain leads were assigned but have
//  had zero agent interaction (empty callHistory) for more than 24 hours.
//  recipientModel: 'Admin' (covers both admin and super_admin roles)
// ─────────────────────────────────────────────────────────────────────────────
async function sendNoActionAlert(recipient, leads, threshold = 'daily') {
  try {
    const messaging = getMessaging();
    const count     = leads.length;

    const thresholdLabel = threshold === '1h' ? '1 hour' : threshold === '2h' ? '2 hours' : '24 hours';
    const urgency        = threshold === '2h' ? '🚨' : threshold === '1h' ? '⚠️' : '⚠️';
    const title = `${urgency} ${count} Lead${count > 1 ? 's' : ''} — No Action in ${thresholdLabel}`;
    const body  = count === 1
      ? `"${leads[0].name}" was assigned ${thresholdLabel} ago with no call or remark yet.`
      : `${count} leads assigned ${thresholdLabel} ago — still no agent activity.`;

    // ── Socket ────────────────────────────────────────────────────────────────
    const _io = global._io;
    if (_io && recipient._id) {
      const room = recipient.role === 'super_admin'
        ? `superadmin:${recipient._id}`
        : `admin:${recipient._id}`;
      _io.to(room).emit('no_action_alert', {
        count,
        threshold,
        leads: leads.map(l => ({ leadId: String(l._id), leadName: l.name, assignedTo: l.user?.name || '' })),
        timestamp: new Date().toISOString(),
      });
    }

    // ── FCM ───────────────────────────────────────────────────────────────────
    if (!messaging || !recipient.fcmToken) return;
    await messaging.send({
      token: recipient.fcmToken,
      notification: { title, body },
      data: {
        type:    'no_action_alert',
        threshold,
        count:   String(count),
        leadIds: leads.map(l => String(l._id)).join(','),
      },
      android: {
        priority: 'high',
        notification: { channelId: 'new_lead_channel_v2', priority: 'max', defaultSound: true, defaultVibrateTimings: true },
      },
      apns: {
        payload: { aps: { alert: { title, body }, sound: 'default', badge: count, 'content-available': 1 } },
        headers: { 'apns-priority': '10' },
      },
    });
    console.log(`[FCM] ✅ No-action alert sent to "${recipient.name}" — ${count} lead(s)`);
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
      // Clear stale token — check both Admin and User collections
      const role = String(recipient.role || '').toLowerCase();
      if (role === 'user' || role === 'employee') {
        const UserModel = require('../models/Users');
        await UserModel.findByIdAndUpdate(recipient._id, { $set: { fcmToken: null } }).catch(() => {});
      } else {
        await Admin.findByIdAndUpdate(recipient._id, { $set: { fcmToken: null } }).catch(() => {});
      }
      console.warn(`[FCM] Cleared stale FCM token for "${recipient.name}" (role: ${recipient.role})`);
    } else {
      console.error('[FCM] sendNoActionAlert error:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  sendFollowUpAlert(recipient, leads, type)
//
//  Notifies an admin or superadmin that certain leads have overdue or
//  today-due scheduled follow-up calls that haven't been marked done.
// ─────────────────────────────────────────────────────────────────────────────
async function sendFollowUpAlert(recipient, leads, type = 'due') {
  try {
    const messaging = getMessaging();
    const count     = leads.length;
    const isOverdue = type === 'overdue';
    const title     = isOverdue
      ? `🔴 ${count} Overdue Follow-Up${count > 1 ? 's' : ''}`
      : `🟡 ${count} Follow-Up${count > 1 ? 's' : ''} Due Today`;
    const body = count === 1
      ? `"${leads[0].name}" — ${isOverdue ? 'overdue follow-up missed' : 'follow-up due today'}.`
      : `${count} leads need follow-up ${isOverdue ? '(overdue)' : 'today'}.`;

    // ── Socket ────────────────────────────────────────────────────────────────
    const _io = global._io;
    if (_io && recipient._id) {
      // FIX: employees (role='user') join 'agent:id' rooms, not 'admin:id'
      const role = String(recipient.role || '').toLowerCase();
      const room = role === 'super_admin' || role === 'superadmin'
        ? `superadmin:${recipient._id}`
        : role === 'user' || role === 'employee'
          ? `agent:${recipient._id}`
          : `admin:${recipient._id}`;
      _io.to(room).emit('follow_up_alert', {
        type,
        count,
        leads: leads.map(l => ({ leadId: String(l._id), leadName: l.name })),
        timestamp: new Date().toISOString(),
      });
    }

    // ── FCM ───────────────────────────────────────────────────────────────────
    if (!messaging || !recipient.fcmToken) return;
    await messaging.send({
      token: recipient.fcmToken,
      notification: { title, body },
      data: {
        type:    'follow_up_alert',
        subType: type,
        count:   String(count),
        leadIds: leads.map(l => String(l._id)).join(','),
      },
      android: {
        priority: 'high',
        notification: { channelId: 'new_lead_channel_v2', priority: 'max', defaultSound: true, defaultVibrateTimings: true },
      },
      apns: {
        payload: { aps: { alert: { title, body }, sound: 'default', badge: count, 'content-available': 1 } },
        headers: { 'apns-priority': '10' },
      },
    });
    console.log(`[FCM] ✅ Follow-up alert (${type}) sent to "${recipient.name}" — ${count} lead(s)`);
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
      // Clear stale token — check both Admin and User collections
      const role = String(recipient.role || '').toLowerCase();
      if (role === 'user' || role === 'employee') {
        const UserModel = require('../models/Users');
        await UserModel.findByIdAndUpdate(recipient._id, { $set: { fcmToken: null } }).catch(() => {});
      } else {
        await Admin.findByIdAndUpdate(recipient._id, { $set: { fcmToken: null } }).catch(() => {});
      }
      console.warn(`[FCM] Cleared stale FCM token for "${recipient.name}" (role: ${recipient.role})`);
    } else {
      console.error('[FCM] sendFollowUpAlert error:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  sendEscalationAlert(superAdmin, adminBreakdown, totalCount)           BUG 1 FIX
//
//  Called by leadAlertsJob when leads have had zero agent action for 3+ hours.
//  Unlike sendNoActionAlert (which targets one admin's own leads), this sends
//  a cross-admin summary to the super_admin so they can see which admin's queue
//  is stalled.
//
//  superAdmin      — Admin document with _id, name, fcmToken
//  adminBreakdown  — Array of { adminName, count, leads[] }
//  totalCount      — Sum of all counts across the breakdown
// ─────────────────────────────────────────────────────────────────────────────
async function sendEscalationAlert(superAdmin, adminBreakdown, totalCount) {
  try {
    const title = `🚨 ${totalCount} Lead${totalCount > 1 ? 's' : ''} — No Action (3h Escalation)`;
    const body  = adminBreakdown
      .map(a => `${a.adminName}: ${a.count} lead${a.count > 1 ? 's' : ''} unactioned`)
      .join(' | ');

    // ── Socket ────────────────────────────────────────────────────────────────
    const _io = global._io;
    if (_io && superAdmin._id) {
      _io.to(`superadmin:${superAdmin._id}`).emit('no_action_alert', {
        count:     totalCount,
        threshold: '3h',
        leads:     adminBreakdown.flatMap(a =>
          a.leads.map(l => ({
            leadId:     String(l._id),
            leadName:   l.name,
            assignedTo: a.adminName,
          }))
        ),
        timestamp: new Date().toISOString(),
      });
    }

    // ── FCM ───────────────────────────────────────────────────────────────────
    const messaging = getMessaging();
    if (!messaging || !superAdmin.fcmToken) return;

    await messaging.send({
      token: superAdmin.fcmToken,
      notification: { title, body },
      data: {
        type:  'escalation_alert',
        count: String(totalCount),
      },
      android: {
        priority: 'high',
        notification: {
          channelId:             'new_lead_channel_v2',
          priority:              'max',
          defaultSound:          true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            badge: totalCount,
            'content-available': 1,
          },
        },
        headers: { 'apns-priority': '10' },
      },
    });

    console.log(`[FCM] ✅ Escalation alert sent to super_admin "${superAdmin.name}" — ${totalCount} lead(s)`);
  } catch (err) {
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      await Admin.findByIdAndUpdate(superAdmin._id, { $set: { fcmToken: null } }).catch(() => {});
      console.warn(`[FCM] Cleared stale FCM token for super_admin "${superAdmin.name}"`);
    } else {
      console.error('[FCM] sendEscalationAlert error:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  sendNoFollowUpAlert(user, leads)
//
//  Notifies the ASSIGNED EMPLOYEE (User model, not Admin) that one or more of
//  their leads have gone 24h+ since creation with no follow-up date ever set.
//  Called by leadAlertsJob.runNoFollowUpDateCheck() every 15 minutes; re-fires
//  every 24h per lead until the employee finally adds a follow-up.
//
//  user  — User document with _id, name, fcmToken
//  leads — array of lead docs { _id, name, mobile, status, date }
// ─────────────────────────────────────────────────────────────────────────────
async function sendNoFollowUpAlert(user, leads) {
  if (!user?._id || !leads?.length) return;

  try {
    const count = leads.length;
    const title = `🔔 ${count} Lead${count > 1 ? 's' : ''} — No Follow-Up Date Set`;
    const body  = count === 1
      ? `"${leads[0].name}" has had no follow-up scheduled for 24+ hours.`
      : `${count} of your leads have no follow-up date set (24+ hours old).`;

    // ── Socket — employee's personal room, same one used for new_lead_assigned ─
    const _io = global._io;
    if (_io) {
      _io.to(`agent:${user._id}`).emit('no_followup_alert', {
        count,
        leads: leads.map(l => ({ leadId: String(l._id), leadName: l.name, mobile: l.mobile || '' })),
        timestamp: new Date().toISOString(),
      });
    }

    // ── FCM ───────────────────────────────────────────────────────────────────
    const messaging = getMessaging();
    if (!messaging) {
      if (_initFailed) console.warn('[FCM] sendNoFollowUpAlert skipped — FCM not initialised:', _initError);
      return;
    }
    if (!user.fcmToken) return; // not registered — socket event above still fires

    await messaging.send({
      token: user.fcmToken,
      notification: { title, body },
      data: {
        type:    'no_followup_alert',
        count:   String(count),
        leadIds: leads.map(l => String(l._id)).join(','),
      },
      android: {
        priority: 'high',
        notification: { channelId: 'new_lead_channel_v2', priority: 'max', defaultSound: true, defaultVibrateTimings: true },
      },
      apns: {
        payload: { aps: { alert: { title, body }, sound: 'default', badge: count, 'content-available': 1 } },
        headers: { 'apns-priority': '10' },
      },
    });
    console.log(`[FCM] ✅ No-follow-up alert sent to "${user.name}" — ${count} lead(s)`);
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
      await clearStaleToken(user._id);
    } else {
      console.error('[FCM] sendNoFollowUpAlert error:', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  sendWhatsAppInboundNotification(companyId, { assignedAgentId, waPhone,
//    contactName, leadName, body, conversationId, leadId })
//
//  Called from msg91WebhookController.processMSG91Payload() the moment a
//  customer's WhatsApp message is saved. Socket.io already handles the
//  in-app real-time update; this covers the case Socket.io can't — the app
//  is backgrounded/killed and there's no live connection to emit to.
//
//  Sends to:
//    • the assigned agent (User model), if the conversation has one
//    • every admin/super_admin in the company (Admin model) — the WA admin
//      app's "firehose" view, mirroring the wa_admin / wa_company_<id>
//      socket rooms this same event already goes to
//
//  Fires all sends in parallel and never throws — a push failure must never
//  block or fail the webhook response back to MSG91.
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsAppInboundNotification(companyId, {
  assignedAgentId, waPhone, contactName, leadName, body, conversationId, leadId,
} = {}) {
  const messaging = getMessaging();
  if (!messaging) {
    if (_initFailed) console.warn('[FCM] sendWhatsAppInboundNotification skipped — FCM not initialised:', _initError);
    return;
  }

  try {
    const displayName = contactName || leadName || waPhone || 'Customer';
    const title = `💬 ${displayName}`;
    const bodyText = (body || '').slice(0, 120) || 'Sent a new message';

    const data = {
      type:           'wa_inbound_message',
      conversationId: String(conversationId || ''),
      leadId:         String(leadId || ''),
      waPhone:        waPhone || '',
    };

    const payloadFor = (token) => ({
      token,
      notification: { title, body: bodyText },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId:             'wa_message_channel_v1',
          priority:              'max',
          defaultSound:          true,
          defaultVibrateTimings: true,
          tag:                   `wa_conv_${conversationId || waPhone}`, // collapses repeat pushes for the same thread
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body: bodyText },
            sound: 'default',
            'content-available': 1,
          },
        },
        headers: { 'apns-priority': '10' },
      },
      // ── Web push (browser/PWA clients) ──────────────────────────────────────
      // FCM tokens from the web SDK are the same token format as mobile —
      // no separate send path needed — but without this block, browser
      // notifications fall back to defaults with no icon and no click
      // behavior. fcm_options.link is what firebase-messaging-sw.js's
      // notificationclick handler needs to open the right conversation.
      webpush: {
        notification: {
          title,
          body: bodyText,
          icon: '/icons/icon-192.png',
          tag: `wa_conv_${conversationId || waPhone}`,
        },
        fcmOptions: {
          link: conversationId ? `/chat/${conversationId}` : '/',
        },
      },
    });

    // ── Collect recipient tokens ─────────────────────────────────────────────
    const recipients = []; // { token, kind: 'admin' | 'agent', id }

    const [admins, agent] = await Promise.all([
      Admin.find({ company: companyId, role: { $in: ['admin', 'super_admin'] }, fcmToken: { $ne: null } })
        .select('_id fcmToken').lean(),
      assignedAgentId
        ? User.findById(assignedAgentId).select('_id fcmToken').lean()
        : Promise.resolve(null),
    ]);

    admins.forEach((a) => { if (a.fcmToken) recipients.push({ token: a.fcmToken, kind: 'admin', id: a._id }); });
    if (agent?.fcmToken) recipients.push({ token: agent.fcmToken, kind: 'agent', id: agent._id });

    if (recipients.length === 0) {
      console.warn(`[FCM] sendWhatsAppInboundNotification: no registered tokens for company ${companyId}`);
      return;
    }

    const results = await Promise.allSettled(
      recipients.map((r) => messaging.send(payloadFor(r.token)))
    );

    let sent = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        sent++;
        continue;
      }
      const err = r.reason;
      const recipient = recipients[i];
      if (
        err?.code === 'messaging/registration-token-not-registered' ||
        err?.code === 'messaging/invalid-registration-token'
      ) {
        if (recipient.kind === 'admin') {
          await Admin.findByIdAndUpdate(recipient.id, { $set: { fcmToken: null } }).catch(() => {});
        } else {
          await User.findByIdAndUpdate(recipient.id, { $set: { fcmToken: null } }).catch(() => {});
        }
      } else {
        console.error('[FCM] sendWhatsAppInboundNotification send error:', err?.message);
      }
    }

    console.log(`[FCM] ✅ WhatsApp inbound push sent to ${sent}/${recipients.length} recipient(s) for company ${companyId}`);
  } catch (err) {
    console.error('[FCM] sendWhatsAppInboundNotification error:', err.message);
  }
}

module.exports = {
  sendNewLeadNotification,
  sendReassignedLeadNotification,
  notifySuperAdminReassignment,
  sendNoActionAlert,
  sendFollowUpAlert,
  sendEscalationAlert,   // BUG 1 FIX — was missing, crashed leadAlertsJob every tick
  sendNoFollowUpAlert,
  sendWhatsAppInboundNotification,
  checkFCMHealth,
};
