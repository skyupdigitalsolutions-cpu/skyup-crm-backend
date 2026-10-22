// services/agentPushService.js
// ─────────────────────────────────────────────────────────────────────────────
// WEB PUSH FOR THE /agent WEB APP (PWA) — alerts that arrive while the app is CLOSED.
//
// The /agent app gets its alerts over socket.io, which only works while the app is open. iPhone closes a
// background web app within minutes, so without this, iPhone employees missed new leads and follow-up reminders.
// This sends the same alerts as standard Web Push (works in the installed app on iPhone iOS 16.4+ and on Android).
//
// HOW IT HOOKS IN: every employee alert is already emitted to that employee's own socket room `agent:<userId>`
// (about 15 places: lead create / reassign / import / pool, WhatsApp, team, webhooks, alert jobs, admin approvals).
// attachToSocket(io) wraps io.to()/io.in() so that when one of the events in BUILDERS is emitted to an
// `agent:<id>` room, the same alert is also pushed to that employee's subscribed phones. One hook covers every
// current and future emit site. The Android app (FCM, services/fcmService.js) is not touched.
// Only rooms passed directly to io.to()/io.in() are seen (not chained .to().to()), which is how all sites emit.
//
// SETUP (one time):
//   npx web-push generate-vapid-keys
//   AGENT_VAPID_PUBLIC_KEY=<public key>
//   AGENT_VAPID_PRIVATE_KEY=<private key>
//   AGENT_VAPID_SUBJECT=mailto:<support email>        (optional, default below)
// Without the keys everything here is a silent no-op and the app keeps working as before.
// Never change the keys once phones have subscribed — every phone would have to turn alerts on again
// (the app does re-subscribe by itself the next time it is opened).
// ─────────────────────────────────────────────────────────────────────────────
const webpush = require('web-push');
const AgentPushSubscription = require('../models/AgentPushSubscription');

const PUBLIC_KEY  = (process.env.AGENT_VAPID_PUBLIC_KEY || '').trim();
const PRIVATE_KEY = (process.env.AGENT_VAPID_PRIVATE_KEY || '').trim();
const SUBJECT     = (process.env.AGENT_VAPID_SUBJECT || 'mailto:skyupdigitalsolutions@gmail.com').trim();

let configured = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
    console.log('[AgentPush] ✅ Web push for the /agent app is active.');
  } catch (e) {
    console.error('[AgentPush] ❌ Invalid VAPID keys — web push disabled:', e.message);
  }
} else {
  console.warn('[AgentPush] AGENT_VAPID_PUBLIC_KEY / AGENT_VAPID_PRIVATE_KEY not set — /agent closed-app notifications are off.');
}

const isConfigured = () => configured;
const publicKey = () => (configured ? PUBLIC_KEY : '');

const MAX_SUBS_PER_USER = 5;

// ── Event → notification. Titles match what the app shows in its in-app banner, and the `tag` matches the app's
// own local notification for the same event, so a phone never shows the same alert twice.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const minutesUntil = (at) => Math.round((new Date(at).getTime() - Date.now()) / 60000);

const BUILDERS = {
  new_lead_assigned: (p = {}) => {
    const count = Number(p.count) || 1;
    const type  = String(p.eventType || 'assigned');
    const many  = !p.leadId && count > 1;
    const title = type === 'reassigned' ? 'Lead reassigned to you'
      : many ? `${plural(count, 'new lead')} assigned` : 'New lead assigned';
    const body  = [p.leadName, p.source].filter(Boolean).join(' — ') || 'Open your leads to see it.';
    return {
      title, body,
      url: p.leadId ? `/agent/leads/${p.leadId}` : '/agent/leads',
      tag: p.leadId ? `lead-${p.leadId}` : `leads-${type}-${Date.now()}`,
      ttl: 24 * 3600,
    };
  },
  meeting_permission_response: (p = {}) => ({
    title: p.approved ? 'Remote clock-in approved' : 'Remote clock-in declined',
    body: p.approved ? `${p.adminName || 'Your admin'} approved it. You can clock in now.`
      : `${p.adminName || 'Your admin'} declined it. Clock in from the office.`,
    url: '/agent', tag: 'remote-clockin', ttl: 6 * 3600,
  }),
  scheduled_call_reminder: (p = {}) => {
    const m = p.scheduledAt ? minutesUntil(p.scheduledAt) : 0;
    return {
      title: `Call back — ${p.leadName || 'lead'}`,
      body: m <= 0 ? 'Scheduled for now' : `Scheduled in ${m} min`,
      url: p.leadId ? `/agent/leads/${p.leadId}` : '/agent/leads',
      tag: `call-${p.leadId || ''}-${p.scheduledAt || ''}`, ttl: 30 * 60,
    };
  },
  follow_up_alert: (p = {}) => {
    const count = Number(p.count) || (p.leads || []).length || 1;
    const overdue = p.type === 'overdue';
    const one = (p.leads || [])[0];
    return {
      title: overdue ? `${plural(count, 'overdue follow-up')}` : `${plural(count, 'follow-up')} due today`,
      body: count === 1 && one ? `${one.leadName || 'A lead'} — ${overdue ? 'follow-up missed' : 'follow-up due today'}` : 'Open your leads to see them.',
      url: count === 1 && one && one.leadId ? `/agent/leads/${one.leadId}` : '/agent/leads',
      tag: `fu-summary-${overdue ? 'overdue' : 'due'}`, ttl: 6 * 3600,
    };
  },
  no_followup_alert: (p = {}) => {
    const count = Number(p.count) || (p.leads || []).length || 1;
    return {
      title: `${plural(count, 'lead')} without a follow-up date`,
      body: 'Set a follow-up so they are not forgotten.',
      url: '/agent/leads', tag: 'no-followup', ttl: 12 * 3600,
    };
  },
};

// ── Alert settings (Profile → Alerts in the app). Same names and defaults as src/agent/alertPrefs.js. ───────────────
const LEAD_TIMES = [5, 10, 15];
const DEFAULT_PREFS = { newLeads: true, followUps: true, followUpLeadMin: 10, followUpSummary: true };
const MAX_PUSH_DELAY_MS = 15 * 60000;       // the server announces a call-back at most 15 min before it

/** Only known keys with the right type; anything else falls back to the default. Never throws. */
function normalizePrefs(p) {
  const src = p && typeof p === 'object' ? p : {};
  const out = { ...DEFAULT_PREFS };
  for (const k of ['newLeads', 'followUps', 'followUpSummary']) if (typeof src[k] === 'boolean') out[k] = src[k];
  if (LEAD_TIMES.includes(Number(src.followUpLeadMin))) out.followUpLeadMin = Number(src.followUpLeadMin);
  return out;
}

/**
 * Should this alert go to a phone with these settings, and how long to hold it back?
 *   new lead / reassigned      → "New leads"
 *   call-back reminder         → "Follow-up reminders"; held back until `followUpLeadMin` minutes before the call
 *                                (the server announces it up to 15 min early, the employee may want 5 or 10)
 *   follow-ups due today       → "Follow-up reminders"
 *   overdue / no follow-up set → "Overdue follow-ups"
 *   remote clock-in reply      → always (the employee is waiting for it)
 */
function decideForEvent(prefs, event, payload, now = Date.now()) {
  const p = prefs || DEFAULT_PREFS;
  switch (event) {
    case 'new_lead_assigned': return { send: p.newLeads, delayMs: 0 };
    case 'scheduled_call_reminder': {
      if (!p.followUps) return { send: false, delayMs: 0 };
      const at = new Date(payload && payload.scheduledAt).getTime();
      if (!Number.isFinite(at)) return { send: true, delayMs: 0 };
      const delay = at - now - p.followUpLeadMin * 60000;
      return { send: true, delayMs: Math.min(Math.max(delay, 0), MAX_PUSH_DELAY_MS) };
    }
    case 'follow_up_alert': return { send: payload && payload.type === 'overdue' ? p.followUpSummary : p.followUps, delayMs: 0 };
    case 'no_followup_alert': return { send: p.followUpSummary, delayMs: 0 };
    default: return { send: true, delayMs: 0 };
  }
}

const safeUrl = (u) => (typeof u === 'string' && u.startsWith('/agent') ? u : '/agent');

/**
 * Push one notification to every subscribed phone of this employee. Returns how many got it right now. Never throws.
 * opts.decide(prefs) → { send, delayMs } lets each phone's own alert settings skip the alert or hold it back;
 * opts.rebuild() builds the text again at the moment a held-back alert is finally sent (so "in 15 min" is not stale).
 */
async function sendToUser(userId, note, opts = {}) {
  if (!configured || !userId || !note) return 0;
  let subs;
  try { subs = await AgentPushSubscription.find({ user: userId }).lean(); } catch (e) { console.error('[AgentPush] lookup failed:', e.message); return 0; }
  if (!subs.length) return 0;
  const bodyOf = (n) => JSON.stringify({ title: n.title, body: n.body || '', url: safeUrl(n.url), tag: n.tag || undefined });
  const sendOne = async (s, n) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, bodyOf(n), { TTL: n.ttl || 3600, urgency: 'high' });
      return true;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        // the phone unsubscribed, the app was removed, or the browser expired the subscription
        await AgentPushSubscription.deleteOne({ _id: s._id }).catch(() => {});
      } else {
        console.error(`[AgentPush] send failed (${code || 'network'}) for user ${userId}:`, (e && (e.body || e.message)) || e);
      }
      return false;
    }
  };
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    let d = { send: true, delayMs: 0 };
    if (typeof opts.decide === 'function') { try { d = opts.decide(normalizePrefs(s.prefs)) || d; } catch { /* send as usual */ } }
    if (!d.send) return;
    if (d.delayMs > 0) {                       // hold back until the employee's chosen lead time (at most 15 min)
      const t = setTimeout(() => {
        let n = note;
        if (typeof opts.rebuild === 'function') { try { n = opts.rebuild() || note; } catch { /* use the first text */ } }
        sendOne(s, n).catch(() => {});
      }, d.delayMs);
      if (t.unref) t.unref();
      return;
    }
    if (await sendOne(s, note)) sent++;
  }));
  return sent;
}

/** Push the alert for a socket event, if it is one the /agent app shows. */
function pushForEvent(userId, event, payload) {
  const build = BUILDERS[event];
  if (!configured || !build) return;
  let note;
  try { note = build(payload); } catch { return; }
  sendToUser(userId, note, {
    decide: (prefs) => decideForEvent(prefs, event, payload),
    rebuild: () => build(payload),
  }).catch(() => {});
}

/** Wrap io.to()/io.in() so employee-room emits also go out as web push. Call once, right after creating io. */
function attachToSocket(io) {
  if (!io || io.__agentPushAttached) return;
  io.__agentPushAttached = true;
  const wrap = (orig) => function wrappedTo(room, ...rest) {
    const op = orig.call(this, room, ...rest);
    try {
      const rooms = [].concat(room).map(String).filter((r) => r.startsWith('agent:'));
      if (configured && rooms.length && op && typeof op.emit === 'function') {
        const emit = op.emit.bind(op);
        op.emit = (event, ...args) => {
          if (BUILDERS[event]) for (const r of rooms) pushForEvent(r.slice('agent:'.length), event, args[0]);
          return emit(event, ...args);
        };
      }
    } catch (e) { console.error('[AgentPush] hook error:', e.message); }
    return op;
  };
  if (typeof io.to === 'function') io.to = wrap(io.to);
  if (typeof io.in === 'function') io.in = wrap(io.in);
}

/** Save (or move to this employee) a phone's subscription. */
async function saveSubscription({ userId, companyId, endpoint, keys, userAgent, prefs }) {
  const set = { user: userId, company: companyId || null, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: String(userAgent || '').slice(0, 300), lastSeenAt: new Date() };
  if (prefs && typeof prefs === 'object') set.prefs = normalizePrefs(prefs);       // not sent → keep the settings already saved
  const doc = await AgentPushSubscription.findOneAndUpdate(
    { endpoint },
    { $set: set },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  // keep only the most recent few per employee
  const extra = await AgentPushSubscription.find({ user: userId }).sort({ lastSeenAt: -1 }).skip(MAX_SUBS_PER_USER).select('_id').lean();
  if (extra.length) await AgentPushSubscription.deleteMany({ _id: { $in: extra.map((x) => x._id) } });
  return doc;
}

async function removeSubscription({ userId, endpoint }) {
  return AgentPushSubscription.deleteOne({ user: userId, endpoint });
}

/** Save the alert settings for one of THIS employee's phones. Returns the saved settings, or null if that phone is not subscribed. */
async function updatePrefs({ userId, endpoint, prefs }) {
  const clean = normalizePrefs(prefs);
  const doc = await AgentPushSubscription.findOneAndUpdate({ user: userId, endpoint }, { $set: { prefs: clean, lastSeenAt: new Date() } }, { new: true });
  return doc ? clean : null;
}

/** "Send test notification": one push to one of THIS employee's phones. → { sent: 1 | 0, reason? } */
async function sendTest({ userId, endpoint }) {
  if (!configured) return { sent: 0, reason: 'off' };
  const sub = await AgentPushSubscription.findOne({ user: userId, endpoint }).lean();
  if (!sub) return { sent: 0, reason: 'unknown' };
  const body = JSON.stringify({ title: 'SkyUp CRM test', body: 'Phone notifications are working on this phone.', url: '/agent/profile', tag: 'push-test' });
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 300, urgency: 'high' });
    return { sent: 1 };
  } catch (e) {
    const code = e && e.statusCode;
    if (code === 404 || code === 410) { await AgentPushSubscription.deleteOne({ _id: sub._id }).catch(() => {}); return { sent: 0, reason: 'gone' }; }
    console.error(`[AgentPush] test send failed (${code || 'network'}):`, (e && (e.body || e.message)) || e);
    return { sent: 0, reason: 'error' };
  }
}

module.exports = { isConfigured, publicKey, sendToUser, pushForEvent, attachToSocket, saveSubscription, removeSubscription, updatePrefs, sendTest, normalizePrefs, decideForEvent, DEFAULT_PREFS, BUILDERS };
