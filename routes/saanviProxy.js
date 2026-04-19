const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const { protect } = require('../middlewares/authMiddleware');

const getSaanviBase = () =>
  process.env.SAANVI_URL || 'https://skyupdigitalsolutions.in';

// ── POST /api/saanvi/leads  →  POST skyupdigitalsolutions.in/api/leads ────────
router.post('/leads', protect, async (req, res) => {
  try {
    const { data } = await axios.post(`${getSaanviBase()}/api/leads`, req.body);
    res.json(data);
  } catch (err) {
    console.error('Saanvi proxy [POST /leads] error:', err.message);
    res.status(err.response?.status || 502).json({
      error: 'Saanvi proxy error',
      detail: err.response?.data || err.message,
    });
  }
});

// ── GET /api/saanvi/leads/:id  →  GET skyupdigitalsolutions.in/api/leads/:id ──
router.get('/leads/:id', protect, async (req, res) => {
  try {
    const { data } = await axios.get(`${getSaanviBase()}/api/leads/${req.params.id}`);
    res.json(data);
  } catch (err) {
    console.error('Saanvi proxy [GET /leads/:id] error:', err.message);
    res.status(err.response?.status || 502).json({
      error: 'Saanvi proxy error',
      detail: err.response?.data || err.message,
    });
  }
});

// ── POST /api/saanvi/call-me  →  POST skyupdigitalsolutions.in/call-me ────────
router.post('/call-me', protect, async (req, res) => {
  try {
    const { data } = await axios.post(`${getSaanviBase()}/call-me`, req.body);
    res.json(data);
  } catch (err) {
    console.error('Saanvi proxy [POST /call-me] error:', err.message);
    res.status(err.response?.status || 502).json({
      error: 'Saanvi proxy error',
      detail: err.response?.data || err.message,
    });
  }
});

module.exports = router;
