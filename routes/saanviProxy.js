const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const jwt     = require('jsonwebtoken');

const getSaanviBase = () =>
  process.env.SAANVI_URL || 'https://skyupdigitalsolutions.in';

// ── Middleware: accepts both user AND admin tokens ────────────────────────────
// The standard `protect` rejects admin tokens with 403.
// The voicebot proxy is called by admins running campaigns, so we allow both.
const protectAny = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
  try {
    const token   = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.tokenPayload = decoded; // role is available if needed
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Not authorized, invalid token' });
  }
};

// ── POST /api/saanvi/leads  →  POST skyupdigitalsolutions.in/api/leads ────────
router.post('/leads', protectAny, async (req, res) => {
  try {
    const { data } = await axios.post(`${getSaanviBase()}/api/leads`, req.body, { timeout: 10000 });
    res.json(data);
  } catch (err) {
    console.error('Saanvi proxy [POST /leads] error:', err.message);
    res.status(err.response?.status || 502).json({
      error:  'Saanvi proxy error',
      detail: err.response?.data || err.message,
    });
  }
});

// ── GET /api/saanvi/leads/:id  →  GET skyupdigitalsolutions.in/api/leads/:id ──
router.get('/leads/:id', protectAny, async (req, res) => {
  try {
    const { data } = await axios.get(`${getSaanviBase()}/api/leads/${req.params.id}`, { timeout: 10000 });
    res.json(data);
  } catch (err) {
    console.error('Saanvi proxy [GET /leads/:id] error:', err.message);
    res.status(err.response?.status || 502).json({
      error:  'Saanvi proxy error',
      detail: err.response?.data || err.message,
    });
  }
});

// ── POST /api/saanvi/call-me  →  POST skyupdigitalsolutions.in/call-me ────────
router.post('/call-me', protectAny, async (req, res) => {
  try {
    const { data } = await axios.post(`${getSaanviBase()}/call-me`, req.body, { timeout: 15000 });
    res.json(data);
  } catch (err) {
    console.error('Saanvi proxy [POST /call-me] error:', err.message);
    res.status(err.response?.status || 502).json({
      error:  'Saanvi proxy error',
      detail: err.response?.data || err.message,
    });
  }
});

module.exports = router;