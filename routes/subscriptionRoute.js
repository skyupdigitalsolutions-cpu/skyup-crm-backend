// routes/subscriptionRoute.js
const express = require("express");
const router = express.Router();
const { superAdminProtect } = require("../middlewares/superAdminMiddleware");
const {
  activateSubscription,
  cancelSubscription,
  extendTrial,
  getAllSubscriptions,
  getPlans,
} = require("../controllers/subscriptionController");

// All subscription management is SuperAdmin only
router.get("/plans",                          getPlans);
router.get("/all",        superAdminProtect,  getAllSubscriptions);
router.post("/activate/:companyId", superAdminProtect, activateSubscription);
router.post("/cancel/:companyId",   superAdminProtect, cancelSubscription);
router.post("/extend-trial/:companyId", superAdminProtect, extendTrial);

module.exports = router;