// services/fcmService.js
// ─────────────────────────────────────────────────────────────────────────────
//  FCM PUSH NOTIFICATION SERVICE
//
//  ── One-time setup ───────────────────────────────────────────────────────────
//  1. npm install firebase-admin
//  2. Go to Firebase Console → Project Settings → Service Accounts
//     → Generate new private key  → save the JSON file
//  3. Set ONE of these env vars:
//
//     Local (.env):
//       GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccount.json
//
//     Render / cloud (paste the whole JSON as the value):
//       FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
//
//  The file is safe to deploy without Firebase — it silently no-ops when
//  the env vars are missing, so the server never crashes.
// ─────────────────────────────────────────────────────────────────────────────

const User = require('../models/Users');

// ── Lazy Firebase init ────────────────────────────────────────────────────────
let _messaging  = null;
let _initFailed = false;

function getMessaging() {
  if (_messaging)  return _messaging;
  if (_initFailed) return null;

  try {
    const admin = require('firebase-admin');

    if (!admin.apps.length) {
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

      if (serviceAccountJson) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
        });
        console.log('[FCM] ✅ Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT_JSON');
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        });
        console.log('[FCM] ✅ Firebase Admin initialized from GOOGLE_APPLICATION_CREDENTIALS');
      } else {
        console.warn('[FCM] ⚠️  No Firebase credentials set — push notifications disabled.');
        _initFailed = true;
        return null;
      }
    }

    _messaging = admin.messaging();
    return _messaging;
  } catch (err) {
    console.warn('[FCM] ⚠️  Firebase Admin init failed:', err.message);
    _initFailed = true;
    return null;
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
  if (!messaging) return;

  try {
    const user = await User.findById(userId).select('fcmToken name').lean();
    if (!user?.fcmToken) return;

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
  if (!messaging) return;

  try {
    const user = await User.findById(userId).select('fcmToken name').lean();
    if (!user?.fcmToken) return;

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
        leadMobile: lead.mobile  || '',
        leadSource: lead.source  || '',
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

module.exports = { sendNewLeadNotification, sendReassignedLeadNotification };
