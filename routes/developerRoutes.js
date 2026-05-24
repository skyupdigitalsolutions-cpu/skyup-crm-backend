// routes/developerRoutes.js — NEW FILE
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



router.get("/dashboard",                       getDeveloperDashboard);   // aggregated counts only
router.get("/companies",                       getCompanies);
router.post("/companies",                      createCompany);
router.post("/companies/:id/super-admin",      createCompanySuperAdmin);
router.put("/companies/:id",                   updateCompany);
router.put("/companies/:id/toggle",            toggleCompanyStatus);
router.get("/subscriptions",                   getSubscriptions);
router.put("/subscriptions/:companyId",        updateSubscription);


// ── Plan CRUD — developer only ────────────────────────────────────────────────
router.get("/plans",        getPlans);
router.post("/plans",       createPlan);
router.get("/plans/:id",    getPlan);
router.put("/plans/:id",    updatePlan);
router.delete("/plans/:id", deletePlan);

module.exports = router;
