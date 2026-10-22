// routes/agentPushRoutes.js — web push subscriptions for the /agent web app (employees only; see services/agentPushService.js)
//   GET  /api/agent-push/public-key    → { enabled, publicKey }
//   POST /api/agent-push/subscribe     { endpoint, keys: { p256dh, auth } }
//   POST /api/agent-push/unsubscribe   { endpoint }
//   POST /api/agent-push/prefs         { endpoint, prefs }   Profile → Alerts choices for one phone
//   POST /api/agent-push/test          { endpoint }          "Send test notification"
const express = require('express');
const router  = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const push = require('../services/agentPushService');

const validEndpoint = (e) => {
  if (typeof e !== 'string' || e.length > 1000) return false;
  try { return new URL(e).protocol === 'https:'; } catch { return false; }
};
const validKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 200 && /^[A-Za-z0-9_\-=+/]+$/.test(k);

router.get('/public-key', protect, (req, res) => {
  res.json({ enabled: push.isConfigured(), publicKey: push.publicKey() });
});

router.post('/subscribe', protect, async (req, res) => {
  try {
    if (!push.isConfigured()) return res.status(503).json({ message: 'Notifications are not set up on the server yet.' });
    const { endpoint, keys, prefs } = req.body || {};
    if (!validEndpoint(endpoint) || !keys || !validKey(keys.p256dh) || !validKey(keys.auth)) {
      return res.status(400).json({ message: 'Invalid push subscription' });
    }
    await push.saveSubscription({
      userId: req.user._id, companyId: req.user.company, endpoint, keys, userAgent: req.headers['user-agent'], prefs,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.post('/unsubscribe', protect, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!validEndpoint(endpoint)) return res.status(400).json({ message: 'Invalid endpoint' });
    await push.removeSubscription({ userId: req.user._id, endpoint });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Save the alert settings (Profile → Alerts) for one of this employee's phones. 404 when that phone is not
// subscribed — the app then subscribes again, which sends the settings along.
router.post('/prefs', protect, async (req, res) => {
  try {
    const { endpoint, prefs } = req.body || {};
    if (!validEndpoint(endpoint) || !prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      return res.status(400).json({ message: 'Invalid settings' });
    }
    const saved = await push.updatePrefs({ userId: req.user._id, endpoint, prefs });
    if (!saved) return res.status(404).json({ message: 'This phone is not subscribed to notifications.' });
    res.json({ ok: true, prefs: saved });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// "Send test notification" — one push to one of this employee's own phones. One test every 5 seconds per employee.
const lastTest = new Map();
router.post('/test', protect, async (req, res) => {
  try {
    if (!push.isConfigured()) return res.status(503).json({ message: 'Notifications are not set up on the server yet.' });
    const { endpoint } = req.body || {};
    if (!validEndpoint(endpoint)) return res.status(400).json({ message: 'Invalid endpoint' });
    const who = String(req.user._id);
    const now = Date.now();
    if (now - (lastTest.get(who) || 0) < 5000) return res.status(429).json({ message: 'Wait a few seconds before sending another test.' });
    lastTest.set(who, now);
    if (lastTest.size > 5000) lastTest.clear();
    const r = await push.sendTest({ userId: req.user._id, endpoint });
    if (r.reason === 'unknown') return res.status(404).json({ message: 'This phone is not subscribed. Turn Phone notifications off and on again.' });
    res.json({ sent: r.sent });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
