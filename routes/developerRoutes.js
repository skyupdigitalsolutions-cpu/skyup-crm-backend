// routes/developerRoutes.js — UPDATED
// Added: GET /plans/config and POST /plans/config for PlanCustomization.jsx
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
  deleteCompany,
  toggleCompanyStatus,
  getSubscriptions,
  updateSubscription,
  // Phase 3
  getCompanyDetails,
  applyDevOverride,
  addAiCredits,
  changeSubscriptionStatus,
  getAuditLogs,
  grantFreeAddon,
  grantBenefit,
  getCompanyPayments,
  setCompanyCloudinary,
} = require("../controllers/developerController");

const {
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getPlan,
  getPlansConfig,   // NEW
  savePlansConfig,  // NEW
} = require("../controllers/planController");

const {
  getCatalog,
  saveCatalog,
  upsertCatalogItem,
  createCustomAddon,
  deleteCustomAddon,
} = require("../controllers/addonCatalogController");

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
router.delete("/companies/:id",           deleteCompany);
router.put("/companies/:id/toggle",       toggleCompanyStatus);

// ── Company detail actions (Phase 3) ─────────────────────────────────────────
router.get("/companies/:id/details",        getCompanyDetails);
router.put("/companies/:id/override",       applyDevOverride);
router.post("/companies/:id/ai-credits",    addAiCredits);
router.put("/companies/:id/status",         changeSubscriptionStatus);
router.get("/companies/:id/audit",          getAuditLogs);
router.post("/companies/:id/grant-addon",   grantFreeAddon);
router.post("/companies/:id/grant-benefit", grantBenefit);
router.get("/companies/:id/payments",       getCompanyPayments);
router.put("/companies/:id/cloudinary",     setCompanyCloudinary);

// ── Subscriptions ─────────────────────────────────────────────────────────────
router.get("/subscriptions",            getSubscriptions);
router.put("/subscriptions/:companyId", updateSubscription);

// ── Plan CRUD ─────────────────────────────────────────────────────────────────
// IMPORTANT: /plans/config must be registered BEFORE /plans/:id so Express
// does not treat "config" as an :id param and route it to getPlan / updatePlan.
router.get("/plans/config",  getPlansConfig);   // NEW — used by PlanCustomization.jsx
router.post("/plans/config", savePlansConfig);  // NEW — used by PlanCustomization.jsx

router.get("/plans",         getPlans);
router.post("/plans",        createPlan);
router.get("/plans/:id",     getPlan);
router.put("/plans/:id",     updatePlan);
router.delete("/plans/:id",  deletePlan);

// ── Add-on price catalogue (Plan Customization → Add-on Pricing) ──────────────
router.get("/addon-catalog",            getCatalog);
router.put("/addon-catalog",            saveCatalog);          // bulk upsert
router.post("/addon-catalog/custom",    createCustomAddon);    // create custom addon
router.delete("/addon-catalog/custom/:addonType", deleteCustomAddon);
router.put("/addon-catalog/:addonType", upsertCatalogItem);    // single upsert

module.exports = router;