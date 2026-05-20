// backend/routes/reportRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Report routes — all guarded by protectAny so both admin and user tokens work.
// Role-specific filtering happens inside the controller / service.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const { protectAny }          = require('../middlewares/authMiddleware');
const { protectAdmin }        = require('../middlewares/adminAuthMiddleware');
const {
  dailyReport,
  employeeReport,
  campaignReport,
} = require('../controllers/reportController');

// Works for both admin and user tokens — controller resolves caller identity
router.get('/daily',    protectAny,   dailyReport);

// Admin-only routes
router.get('/employee', protectAdmin, employeeReport);
router.get('/campaign', protectAdmin, campaignReport);

module.exports = router;
