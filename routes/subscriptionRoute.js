// backend/routes/subscriptionRoute.js
// ─────────────────────────────────────────────────────────────────────────────
// FIX: Added developer auth support alongside superadmin so the developer
// dashboard Subscriptions page can call these endpoints with a developer token.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const { protectSuperAdmin }  = require('../middlewares/superAdminMiddleware');
const { protectDeveloper }   = require('../middlewares/developerMiddleware');

const {
  getPlans,
  getAllSubscriptions,
  activateSubscription,
  cancelSubscription,
  extendTrial,
  getCompanySubscription,
} = require('../controllers/subscriptionController');

// ── Middleware: allow either superadmin OR developer ──────────────────────────
// This lets both internal developers and superadmins manage subscriptions.
const protectPrivileged = (req, res, next) => {
  // Try superadmin first, fall back to developer
  protectSuperAdmin(req, res, (superAdminErr) => {
    if (!superAdminErr) return next();           // superadmin OK
    protectDeveloper(req, res, (devErr) => {
      if (!devErr) return next();                // developer OK
      // Neither succeeded — return 403
      return res.status(403).json({
        success: false,
        message: 'Access denied. Requires superadmin or developer role.',
      });
    });
  });
};

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/plans', getPlans);

// ── Privileged (superadmin or developer) ─────────────────────────────────────
router.get('/all',                          protectPrivileged, getAllSubscriptions);
router.get('/:companyId',                   protectPrivileged, getCompanySubscription);
router.post('/activate/:companyId',         protectPrivileged, activateSubscription);
router.post('/cancel/:companyId',           protectPrivileged, cancelSubscription);
router.post('/extend-trial/:companyId',     protectPrivileged, extendTrial);

module.exports = router;
