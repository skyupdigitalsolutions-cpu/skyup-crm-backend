// backend/routes/reportRoutes.js
// ─────────────────────────────────────────────────────────────────────────────
// Report routes — all guarded by protectAny so both admin and user tokens work.
// Role-specific filtering happens inside the controller / service.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const { protectAny }          = require('../middlewares/authMiddleware');
const { protectAdmin }        = require('../middlewares/adminAuthMiddleware');
const { requireFeature }      = require('../middlewares/entitlementMiddleware');
const {
  dailyReport,
  employeeReport,
  campaignReport,
  nonConversionReport,
  dailyOutcomesReport,
} = require('../controllers/reportController');

// Works for both admin and user tokens — controller resolves caller identity
router.get('/daily',          protectAny,   dailyReport);

// Gated: only enabled for the one company it's rolled out to (see
// devOverrides.featureToggles.callOutcomesReport in Company Details).
router.get('/daily-outcomes', protectAny, requireFeature('callOutcomesReport'), dailyOutcomesReport);

// Admin-only routes
router.get('/employee', protectAdmin, employeeReport);
router.get('/campaign', protectAdmin, campaignReport);
router.get('/non-conversion', protectAdmin, nonConversionReport);

module.exports = router;
