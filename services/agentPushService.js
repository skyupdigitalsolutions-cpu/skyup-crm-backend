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

// Which setting (subscription prefs) controls each event. Events not listed always go out.
const CATEGORY = {
  new_lead_assigned: 'newLeads',
  scheduled_call_reminder: 'followUps',
  follow_up_alert: 'followUpSummary',
  no_followup_alert: 'followUpSummary',
};

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

const safeUrl = (u) => (typeof u === 'string' && u.startsWith('/agent') ? u : '/agent');

/** Push one notification to every subscribed phone of this employee (that has `category` switched on).
 *  Returns how many got it. Never throws. */
async function sendToUser(userId, note, category, subsIn) {
  if (!configured || !userId || !note) return 0;
  let subs = subsIn;
  if (!subs) {
    try { subs = await AgentPushSubscription.find({ user: userId }).lean(); } catch (e) { console.error('[AgentPush] lookup failed:', e.message); return 0; }
  }
  if (category) subs = subs.filter((s) => !s.prefs || s.prefs[category] !== false);
  if (!subs.length) return 0;
  const body = JSON.stringify({ title: note.title, body: note.body || '', url: safeUrl(note.url), tag: note.tag || undefined });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: note.ttl || 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        // the phone unsubscribed, the app was removed, or the browser expired the subscription
        await AgentPushSubscription.deleteOne({ _id: s._id }).catch(() => {});
      } else {
        console.error(`[AgentPush] send failed (${code || 'network'}) for user ${userId}:`, (e && (e.body || e.message)) || e);
      }
    }
  }));
  return sent;
}

/** Push the alert for a socket event, if it is one the /agent app shows. */
async function pushForEvent(userId, event, payload) {
  const build = BUILDERS[event];
  if (!configured || !build) return;
  const category = CATEGORY[event];
  if (event !== 'scheduled_call_reminder') {
    let note;
    try { note = build(payload); } catch { return; }
    sendToUser(userId, note, category).catch(() => {});
    return;
  }
  // Call-back reminder: the alert job announces it up to 15 minutes early. Each phone chose how early it wants it
  // (5 / 10 / 15 min, Profile → Alerts), so hold it until then. The text is built at send time ("in 5 min").
  let subs;
  try { subs = (await AgentPushSubscription.find({ user: userId }).lean()).filter((s) => !s.prefs || s.prefs.followUps !== false); }
  catch { return; }
  const at = new Date(payload && payload.scheduledAt).getTime();
  const groups = new Map();
  for (const s of subs) {
    const lead = Math.min(15, Math.max(5, Number(s.prefs && s.prefs.followUpLeadMin) || 10));
    const wait = Number.isFinite(at) ? Math.max(0, at - lead * 60000 - Date.now()) : 0;
    if (!groups.has(wait)) groups.set(wait, []);
    groups.get(wait).push(s);
  }
  for (const [wait, group] of groups) {
    const fire = () => { let note; try { note = build(payload); } catch { return; } sendToUser(userId, note, null, group).catch(() => {}); };
    if (wait > 0) { const t = setTimeout(fire, Math.min(wait, 15 * 60000)); if (t.unref) t.unref(); } else fire();
  }
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

/** Only known settings, with safe values. */
function cleanPrefs(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const k of ['newLeads', 'followUps', 'followUpSummary']) if (typeof p[k] === 'boolean') out[`prefs.${k}`] = p[k];
  const m = Number(p.followUpLeadMin);
  if ([5, 10, 15].includes(m)) out['prefs.followUpLeadMin'] = m;
  return Object.keys(out).length ? out : null;
}

/** Save (or move to this employee) a phone's subscription. */
async function saveSubscription({ userId, companyId, endpoint, keys, userAgent, prefs }) {
  const doc = await AgentPushSubscription.findOneAndUpdate(
    { endpoint },
    { $set: { user: userId, company: companyId || null, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: String(userAgent || '').slice(0, 300), lastSeenAt: new Date(), ...(cleanPrefs(prefs) || {}) } },
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

/** Update this phone's notification settings. Returns false when the phone isn't subscribed. */
async function savePrefs({ userId, endpoint, prefs }) {
  const set = cleanPrefs(prefs);
  if (!set) return true;
  const r = await AgentPushSubscription.updateOne({ user: userId, endpoint }, { $set: set });
  return r.matchedCount > 0;
}

/** "Send test notification" button: push to this phone only (or every phone of the employee when no endpoint). */
async function sendTest({ userId, endpoint }) {
  const subs = await AgentPushSubscription.find({ user: userId, ...(endpoint ? { endpoint } : {}) }).lean();
  return sendToUser(userId, { title: 'Test notification', body: 'Notifications are working on this phone.', url: '/agent/profile', tag: 'test', ttl: 300 }, null, subs);
}

module.exports = { isConfigured, publicKey, sendToUser, pushForEvent, attachToSocket, saveSubscription, removeSubscription, savePrefs, sendTest, BUILDERS, CATEGORY };
