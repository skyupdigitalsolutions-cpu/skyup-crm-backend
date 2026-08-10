// routes/dailyReportRoute.js
// ─────────────────────────────────────────────────────────────────────────────
// All endpoints require protectAdmin — company admin or super_admin only.
// Company isolation enforced in controller via getCompanyId(req).
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

const { protectAdmin } = require('../middlewares/adminAuthMiddleware');
const {
  getSettings,
  saveSettings,
  sendTest,
  sendNow,
  getHistory,
} = require('../controllers/dailyReportController');

router.get  ('/settings',  protectAdmin, getSettings);
router.put  ('/settings',  protectAdmin, saveSettings);
router.post ('/test',      protectAdmin, sendTest);
router.post ('/send-now',  protectAdmin, sendNow);
router.get  ('/history',   protectAdmin, getHistory);

module.exports = router;
