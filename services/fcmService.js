// src/services/fcmTokenService.js


import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from './api';

const FCM_TOKEN_STORAGE_KEY   = 'registered_fcm_token';
// Separate flag that marks the token was CONFIRMED saved on the backend.
// If sendTokenToBackend() fails (e.g. 403), we never set this flag, so the
// next app launch will retry instead of silently skipping.
const FCM_TOKEN_CONFIRMED_KEY = 'registered_fcm_token_confirmed';

// ── Safe import — app will not crash if firebase is not installed yet ─────────
let messaging = null;
try {
  messaging = require('@react-native-firebase/messaging').default;
} catch (e) {
  console.warn(
    '[FCMToken] @react-native-firebase/messaging not installed.\n' +
    'Run: npm install @react-native-firebase/app @react-native-firebase/messaging\n' +
    'Then add google-services.json to android/app/ and apply the google-services plugin.\n' +
    'Error:', e.message
  );
}

// ── Register FCM token with backend ──────────────────────────────────────────
async function sendTokenToBackend(token) {
  try {
    await api.patch('/auth/update-device', { fcmToken: token });
    await AsyncStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
    await AsyncStorage.setItem(FCM_TOKEN_CONFIRMED_KEY, 'true');
    console.log('[FCMToken] ✅ Token registered with backend:', token.slice(0, 20) + '...');
  } catch (err) {
    // ── Detailed error log so you can see the exact HTTP status in Logcat ────
    // If you see 403 here → the JWT role is not "user"/"employee" — fix
    //   authMiddleware.js to allow your role, or check the user's role in DB.
    // If you see 401 → token expired or not attached — check api.js interceptor.
    // If you see Network Error → backend is unreachable.
    console.error(
      '[FCMToken] ❌ Failed to send token to backend.' ,
      'Status:', err.response?.status,
      'Body:', JSON.stringify(err.response?.data),
      'Message:', err.message,
    );
    // Do NOT set FCM_TOKEN_STORAGE_KEY or FCM_TOKEN_CONFIRMED_KEY here.
    // This forces a retry on the next registerFCMToken() call instead of
    // silently assuming the backend has the token when it doesn't.
  }
}


export async function registerFCMToken() {
  if (!messaging) return;

  try {
    // ── Request permission (required on iOS and Android 13+) ────────────────
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      console.warn('[FCMToken] Notification permission not granted (status:', authStatus, ')');
      // Don't return — on Android < 13 permission is implicitly granted and
      // requestPermission() may return AUTHORIZED even without a user prompt.
    }

    // ── Get FCM token ────────────────────────────────────────────────────────
    const token = await messaging().getToken();
    if (!token) {
      console.warn('[FCMToken] getToken() returned null — is google-services.json present?');
      return;
    }

    // ── Only send if token changed AND was previously confirmed on backend ───
    // Old logic: skip if storedToken === token (even if backend never got it).
    // New logic: also require FCM_TOKEN_CONFIRMED_KEY === 'true', so a previous
    // failed sendTokenToBackend() always retries on next login.
    const storedToken = await AsyncStorage.getItem(FCM_TOKEN_STORAGE_KEY);
    const confirmed   = await AsyncStorage.getItem(FCM_TOKEN_CONFIRMED_KEY);

    if (storedToken === token && confirmed === 'true') {
      console.log('[FCMToken] Token confirmed on backend — skipping update');
      return;
    }

    await sendTokenToBackend(token);
  } catch (err) {
    console.warn('[FCMToken] registerFCMToken error:', err.message);
  }
}


export function startFCMTokenRefreshListener() {
  if (!messaging) return () => {};

  const unsubscribe = messaging().onTokenRefresh(async (newToken) => {
    console.log('[FCMToken] Token refreshed — updating backend');
    // Clear confirmed flag so sendTokenToBackend runs unconditionally
    await AsyncStorage.removeItem(FCM_TOKEN_CONFIRMED_KEY).catch(() => {});
    await sendTokenToBackend(newToken);
  });

  return unsubscribe;
}


export async function clearFCMToken() {
  try {
    await AsyncStorage.multiRemove([FCM_TOKEN_STORAGE_KEY, FCM_TOKEN_CONFIRMED_KEY]);
  } catch {}
}


// FIX: exported so index.js background handler can call it when app is killed.
// Previously private (_displayFCMNotification) — background handler had no way
// to call it, so killed-app notifications were silently dropped.
export async function displayFCMNotification(data) {
  if (!data?.type) return;
  try {
    let notifee = null;
    let AndroidImportance = null;
    try {
      const mod = require('@notifee/react-native');
      notifee = mod.default ?? mod;
      AndroidImportance = mod.AndroidImportance ?? mod.default?.AndroidImportance;
    } catch { return; }

    if (typeof notifee?.displayNotification !== 'function') return;

    const IMPORTANCE_HIGH = AndroidImportance?.HIGH ?? 4;

    if (data.type === 'new_lead') {
      await notifee.displayNotification({
        id:    `fcm_new_lead_${data.leadId}`,
        title: '🎯 New Lead Assigned',
        body:  `${data.leadName}${data.leadSource ? ' via ' + data.leadSource : ''}`,
        // FIX: previously no `data` was attached — notifee's own press
        // handler (notificationService.js) had nothing to navigate with
        // except brittle id-string prefix matching, which didn't even match
        // this id format. Attaching the real type/leadId lets the shared
        // getFCMNavigationTarget() resolver handle this correctly.
        data: { type: data.type, leadId: data.leadId },
        android: {
          channelId:    'new_lead_channel_v2',
          importance:   IMPORTANCE_HIGH,
          smallIcon:    'ic_notification',
          pressAction:  { id: 'open_leads' },
        },
        ios: {
          sound: 'default',
          foregroundPresentationOptions: { alert: true, sound: true, badge: false },
        },
      });
    } else if (data.type === 'reassigned_lead') {
      await notifee.displayNotification({
        id:    `fcm_reassigned_${data.leadId}`,
        title: '🔄 Lead Reassigned to You',
        body:  `${data.leadName} has been assigned to you`,
        data: { type: data.type, leadId: data.leadId },
        android: {
          channelId:    'new_lead_channel_v2',
          importance:   IMPORTANCE_HIGH,
          smallIcon:    'ic_notification',
          pressAction:  { id: 'open_leads' },
        },
        ios: {
          sound: 'default',
          foregroundPresentationOptions: { alert: true, sound: true, badge: false },
        },
      });

    }
  } catch (e) {
    console.warn('[FCMToken] _displayFCMNotification error:', e.message);
  }
}

export function handleFCMBackgroundMessages() {
  // ✅ FIX ISSUE 3: Background handler is now registered in index.js at the
  // module level — that is the ONLY place Firebase allows it to be registered.
  // Calling setBackgroundMessageHandler() here (inside a component or service)
  // would silently overwrite the index.js handler with a no-op, causing
  // background notifications to stop working.
  // This function is kept as a no-op so existing App.js call doesn't break.
  if (!messaging) return;
  console.log('[FCMToken] Background handler is managed by index.js — skipping duplicate registration');
}


export function startFCMForegroundListener() {
  if (!messaging) return () => {};

  const unsubscribe = messaging().onMessage(async (remoteMessage) => {
    console.log('[FCMToken] Foreground FCM message received:', remoteMessage.data?.type);
    // Display via notifee — same as background handler
    await displayFCMNotification(remoteMessage.data);
  });

  return unsubscribe;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG FIX (notifications received but tapping them doesn't navigate anywhere):
//
// The backend (services/fcmService.js) sends FIVE distinct push types —
// new_lead, reassigned_lead, lead_reassigned_notify, no_action_alert, and
// follow_up_alert — every one of them with a `notification: {title, body}`
// block, meaning Android/iOS displays them via the OS notification tray
// automatically, independent of this app's own notifee display logic.
//
// Tapping an OS-displayed FCM notification is handled by TWO specific
// Firebase Messaging lifecycle callbacks:
//   - messaging().onNotificationOpenedApp() — app was BACKGROUNDED, user tapped
//   - messaging().getInitialNotification()  — app was fully KILLED, the tap is
//     what launched it; must be checked once at cold-start
//
// Neither of these existed anywhere in this app. Only onMessage() (foreground
// arrival) and notifee's own local onForegroundEvent/onBackgroundEvent (which
// only fire for notifee-DISPLAYED notifications, i.e. new_lead/reassigned_lead
// re-displayed via displayFCMNotification below — NOT the OS-level tray
// notification that's actually what gets tapped in the background/killed
// case) were wired up. So a follow-up/no-action/reassignment push would
// arrive and show correctly, but tapping it just opened the app to wherever
// it last was — never the relevant lead.
//
// getFCMNavigationTarget() below is the single source of truth for "given
// this push's data payload, where should tapping it go" — used by the new
// registerFCMNotificationOpenHandlers() function, and reusable by notifee's
// own press handler in notificationService.js for the two types that are
// ALSO re-displayed locally.
export function getFCMNavigationTarget(data) {
  if (!data?.type) return null;

  switch (data.type) {
    case 'new_lead':
    case 'reassigned_lead':
    case 'lead_reassigned_notify':
      // Single-lead types — go straight to that lead if we have an id,
      // otherwise fall back to the leads list.
      return data.leadId
        ? { screen: 'LeadDetail', params: { leadId: data.leadId } }
        : { screen: 'Leads' };

    case 'follow_up_alert':
    case 'no_action_alert': {
      // Multi-lead types — data.leadIds is a comma-separated string. Go
      // straight to the single lead if there's exactly one, otherwise the
      // leads list (no dedicated "filtered by these ids" screen exists yet).
      const ids = String(data.leadIds || '').split(',').map((s) => s.trim()).filter(Boolean);
      return ids.length === 1
        ? { screen: 'LeadDetail', params: { leadId: ids[0] } }
        : { screen: 'Leads' };
    }

    default:
      return null;
  }
}

// Registers the two missing tap-handlers. Call once at app startup, passing
// the same navigationRef already used by registerNotificationHandlers() in
// notificationService.js — both ultimately call nav.navigate the same way.
export function registerFCMNotificationOpenHandlers(navigationRef) {
  if (!messaging) return () => {};

  const navigate = (screen, params) => {
    const nav = navigationRef?.current;
    if (!nav) return;
    nav.navigate('Main');
    if (screen !== 'Main') {
      setTimeout(() => nav.navigate(screen, params), 120);
    }
  };

  const handleOpen = (remoteMessage) => {
    const target = getFCMNavigationTarget(remoteMessage?.data);
    if (target) navigate(target.screen, target.params);
  };

  // App was backgrounded (not killed) and the user tapped the notification.
  const unsubscribeOpened = messaging().onNotificationOpenedApp(handleOpen);

  // App was fully killed — the tap is what launched it. Only fires once,
  // checked here at registration time (called from App.js on mount).
  messaging()
    .getInitialNotification()
    .then((remoteMessage) => {
      if (remoteMessage) handleOpen(remoteMessage);
    })
    .catch((e) => console.warn('[FCMToken] getInitialNotification error:', e.message));

  return unsubscribeOpened;
}
