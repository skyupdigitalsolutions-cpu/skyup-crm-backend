// routes/developerRoutes.js — UPDATED
// Added: company details, dev override, AI credits, status change, audit log,
//        grant-addon, grant-benefit routes for the Developer Panel.
// All existing routes are UNCHANGED.

const express = require("express");
const router  = express.Router();
const { protectUnified, authorizeRoles } = require("../middlewares/authMiddleware");

const {
  developerLogin,
  getDeveloperDashboard,
  createCompany,
  createCompanySuperAdmin,
  getCompanies,
  updateCompany,
  toggleCompanyStatus,
  getSubscriptions,
  updateSubscription,
  // New Phase 3
  getCompanyDetails,
  applyDevOverride,
  addAiCredits,
  changeSubscriptionStatus,
  getAuditLogs,
  grantFreeAddon,
  grantBenefit,
} = require("../controllers/developerController");

const {
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getPlan,
} = require("../controllers/planController");

// ── Public ────────────────────────────────────────────────────────────────────
router.post("/login", developerLogin);

// ── All routes below require developer role ───────────────────────────────────
router.use(protectUnified, authorizeRoles("developer"));

// Dashboard
router.get("/dashboard", getDeveloperDashboard);

// ── Company CRUD ──────────────────────────────────────────────────────────────
router.get("/companies",                  getCompanies);
router.post("/companies",                 createCompany);
router.post("/companies/:id/super-admin", createCompanySuperAdmin);
router.put("/companies/:id",              updateCompany);
router.put("/companies/:id/toggle",       toggleCompanyStatus);

// ── NEW: Company detail actions (Phase 3) ─────────────────────────────────────
// Full details page (subscription + usage + addons + benefits + audit log)
router.get("/companies/:id/details",       getCompanyDetails);

// Developer resource/feature overrides
router.put("/companies/:id/override",      applyDevOverride);

// Add AI credits (transcription / summary packs)
router.post("/companies/:id/ai-credits",   addAiCredits);

// Pause / Resume / Suspend subscription status
router.put("/companies/:id/status",        changeSubscriptionStatus);

// Paginated audit log for a company
router.get("/companies/:id/audit",         getAuditLogs);

// Grant free addon directly from developer panel
router.post("/companies/:id/grant-addon",  grantFreeAddon);

// Grant benefit directly from developer panel
router.post("/companies/:id/grant-benefit", grantBenefit);

// ── Subscriptions (list + update) ─────────────────────────────────────────────
router.get("/subscriptions",              getSubscriptions);
router.put("/subscriptions/:companyId",   updateSubscription);

// ── Plan CRUD ─────────────────────────────────────────────────────────────────
router.get("/plans",        getPlans);
router.post("/plans",       createPlan);
router.get("/plans/:id",    getPlan);
router.put("/plans/:id",    updatePlan);
router.delete("/plans/:id", deletePlan);

module.exports = router;
