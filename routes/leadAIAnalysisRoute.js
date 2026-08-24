// routes/leadAIAnalysisRoute.js
// ─────────────────────────────────────────────────────────────────────────────
// Uses the same auth middleware as all existing lead routes.
// protectAdmin covers both admin and super_admin roles.
// protect covers employees (User role).
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router  = express.Router();

const {
  getAIAnalysis,
  createAIAnalysis,
  reanalyzeAIAnalysis,
  getAIReport,
} = require("../controllers/leadAIAnalysisController");

const { protectAdmin }   = require("../middlewares/adminAuthMiddleware");
const { protect }        = require("../middlewares/authMiddleware");
const { validateObjectId } = require("../middlewares/validateObjectId");

// Management report — admin only
router.get("/ai-report", protectAdmin, getAIReport);

// Lead-level — accessible to both admin and employee
// (employee access: GET only their assigned leads — enforced in controller via company isolation)
router.get(
  "/:leadId/ai-analysis",
  protect,          // try employee first
  validateObjectId("leadId"),
  getAIAnalysis
);

// Admin can also call the same endpoint with admin token
router.get(
  "/admin/:leadId/ai-analysis",
  protectAdmin,
  validateObjectId("leadId"),
  (req, res, next) => { req.params.leadId = req.params.leadId; next(); },
  getAIAnalysis
);

// Trigger new analysis
router.post(
  "/:leadId/ai-analysis",
  protect,
  validateObjectId("leadId"),
  createAIAnalysis
);

router.post(
  "/admin/:leadId/ai-analysis",
  protectAdmin,
  validateObjectId("leadId"),
  createAIAnalysis
);

// Re-analyze
router.post(
  "/:leadId/ai-analysis/reanalyze",
  protect,
  validateObjectId("leadId"),
  reanalyzeAIAnalysis
);

router.post(
  "/admin/:leadId/ai-analysis/reanalyze",
  protectAdmin,
  validateObjectId("leadId"),
  reanalyzeAIAnalysis
);

module.exports = router;
