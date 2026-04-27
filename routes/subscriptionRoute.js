// routes/subscriptionRoute.js
const express = require("express");
const router  = express.Router();

// ✅ Fixed: your middleware exports 'protectSuperAdmin' not 'superAdminProtect'
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");

const {
  activateSubscription,
  cancelSubscription,
  extendTrial,
  getAllSubscriptions,
  getPlans,
} = require("../controllers/subscriptionController");

// Public — anyone can view plans
router.get("/plans", getPlans);

// SuperAdmin only routes
router.get("/all",                      protectSuperAdmin, getAllSubscriptions);
router.post("/activate/:companyId",     protectSuperAdmin, activateSubscription);
router.post("/cancel/:companyId",       protectSuperAdmin, cancelSubscription);
router.post("/extend-trial/:companyId", protectSuperAdmin, extendTrial);

module.exports = router;