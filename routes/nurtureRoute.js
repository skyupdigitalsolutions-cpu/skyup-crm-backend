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
  syncTemplates,
  listTemplates,
  probeTemplates,
  rawTemplates,
  runNow,
  triggerForLead,
} = require("../controllers/nurtureController");

// Admin-only, and gated by the same company-scoped entitlement the cron job
// checks — so an admin at a company without the feature can't even see or
// build rules for it (rules created here are inert until the toggle is on
// anyway, but this keeps the UI honest and avoids confusion).
router.get("/rules",        protectAdmin, requireFeature("leadNurtureSequence"), listRules);
router.post("/rules",       protectAdmin, requireFeature("leadNurtureSequence"), createRule);
router.patch("/rules/:id",  protectAdmin, requireFeature("leadNurtureSequence"), updateRule);
router.delete("/rules/:id", protectAdmin, requireFeature("leadNurtureSequence"), deleteRule);

// ── WhatsApp template cache (auto-fetched from MSG91) ────────────────────────
// GET  /templates        → list cached templates (with ?stage= / ?nurtureOnly= / ?search=)
// POST /templates/sync   → pull the latest list from MSG91 into the cache
// GET  /templates/probe  → diagnostic: find which MSG91 endpoint works
router.get("/templates",        protectAdmin, requireFeature("leadNurtureSequence"), listTemplates);
router.post("/templates/sync",  protectAdmin, requireFeature("leadNurtureSequence"), syncTemplates);
router.get("/templates/raw",    protectAdmin, requireFeature("leadNurtureSequence"), rawTemplates);
router.get("/templates/probe",  protectAdmin, requireFeature("leadNurtureSequence"), probeTemplates);

// ── Manual triggers (admin-only, for testing without waiting for the 11 AM cron)
// POST /run                 → runs the full daily cron check immediately
// POST /trigger/:leadId     → fires rules for one lead at its current status
//                             body: { status } — optional override
router.post("/run",                protectAdmin, requireFeature("leadNurtureSequence"), runNow);
router.post("/trigger/:leadId",    protectAdmin, requireFeature("leadNurtureSequence"), triggerForLead);

module.exports = router;
