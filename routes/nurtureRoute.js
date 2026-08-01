// routes/nurtureRoute.js — NEW FILE
const express = require("express");
const router  = express.Router();

const { protectAdmin }   = require("../middlewares/adminAuthMiddleware");
const { requireFeature } = require("../middlewares/entitlementMiddleware");
const {
  listRules,
  createRule,
  updateRule,
  deleteRule,
} = require("../controllers/nurtureController");

// Admin-only, and gated by the same company-scoped entitlement the cron job
// checks — so an admin at a company without the feature can't even see or
// build rules for it (rules created here are inert until the toggle is on
// anyway, but this keeps the UI honest and avoids confusion).
router.get("/rules",        protectAdmin, requireFeature("leadNurtureSequence"), listRules);
router.post("/rules",       protectAdmin, requireFeature("leadNurtureSequence"), createRule);
router.patch("/rules/:id",  protectAdmin, requireFeature("leadNurtureSequence"), updateRule);
router.delete("/rules/:id", protectAdmin, requireFeature("leadNurtureSequence"), deleteRule);

module.exports = router;
