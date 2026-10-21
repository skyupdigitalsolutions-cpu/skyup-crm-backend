// routes/agentPushRoutes.js — web push subscriptions for the /agent web app (employees only; see services/agentPushService.js)
//   GET  /api/agent-push/public-key    → { enabled, publicKey }
//   POST /api/agent-push/subscribe     { endpoint, keys: { p256dh, auth } }
//   POST /api/agent-push/unsubscribe   { endpoint }
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
    const { endpoint, keys } = req.body || {};
    if (!validEndpoint(endpoint) || !keys || !validKey(keys.p256dh) || !validKey(keys.auth)) {
      return res.status(400).json({ message: 'Invalid push subscription' });
    }
    await push.saveSubscription({
      userId: req.user._id, companyId: req.user.company, endpoint, keys, userAgent: req.headers['user-agent'],
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

module.exports = router;
