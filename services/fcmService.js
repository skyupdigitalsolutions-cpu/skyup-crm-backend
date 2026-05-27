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

const User = require('../models/Users');

// ── Lazy Firebase init ────────────────────────────────────────────────────────
let _messaging  = null;
let _initFailed = false;
let _initError  = null;   // FIX BUG 3: store the reason so per-send logs are useful

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
          // FIX BUG 3: JSON parse failure used to produce a cryptic error later.
          // Now we surface a clear message pointing to the env var.
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
        // FIX BUG 3: Previously this was a warn() that was easy to miss and
        // then every send silently returned without explanation.
        // Now: store the reason so each send() call can log it explicitly.
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

// ── FIX BUG 3: Health check — call this from server.js after connectDB() ─────
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
    // FIX BUG 3: Log the reason so it's visible in per-request logs,
    // not just once at startup. Keeps the original silent-return behaviour
    // (server doesn't crash) but makes the problem undeniable in logs.
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

module.exports = { sendNewLeadNotification, sendReassignedLeadNotification, checkFCMHealth };