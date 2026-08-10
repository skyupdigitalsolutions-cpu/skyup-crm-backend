// routes/dailyReportRoute.js
// ─────────────────────────────────────────────────────────────────────────────
// Daily Telegram Report API routes.
//
// Two access patterns:
//   1. Admin panel  → protectAdmin  → /daily-report/settings (company from token)
//   2. Developer    → protectDeveloper → /developer/companies/:companyId/daily-report/*
//
// Both mount this same router. The controller resolves companyId from:
//   - req.admin.company (admin token)
//   - req.params.companyId (developer route)
//   - x-company-id header (fallback)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true }); // mergeParams for :companyId from parent

const { protectAdmin }     = require('../middlewares/adminAuthMiddleware');
const { protectDeveloper } = require('../middlewares/developerMiddleware');
const {
  getSettings,
  saveSettings,
  sendTest,
  sendNow,
  getHistory,
} = require('../controllers/dailyReportController');

// ── Middleware: accept either admin OR developer token ────────────────────────
const protectAdminOrDeveloper = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1] || '';
  if (!token) return res.status(401).json({ message: 'Not authorized, no token' });

  // Decode role without verifying first to route to correct middleware
  try {
    const jwt     = require('jsonwebtoken');
    const decoded = jwt.decode(token);
    if (decoded?.role === 'developer') {
      return protectDeveloper(req, res, next);
    }
  } catch { /* fall through to protectAdmin */ }

  return protectAdmin(req, res, next);
};

router.get  ('/settings',  protectAdminOrDeveloper, getSettings);
router.put  ('/settings',  protectAdminOrDeveloper, saveSettings);
router.post ('/test',      protectAdminOrDeveloper, sendTest);
router.post ('/send-now',  protectAdminOrDeveloper, sendNow);
router.get  ('/history',   protectAdminOrDeveloper, getHistory);

module.exports = router;
