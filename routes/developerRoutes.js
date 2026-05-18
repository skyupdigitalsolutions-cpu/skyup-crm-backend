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
  toggleCompanyStatus,
  getSubscriptions,
  updateSubscription,
} = require("../controllers/developerController");

// ── Public ────────────────────────────────────────────────────────────────────
router.post("/login", developerLogin);

// ── All routes below require developer role ───────────────────────────────────
router.use(protectUnified, authorizeRoles("developer"));

router.get("/dashboard",                       getDeveloperDashboard);   // aggregated counts only
router.get("/companies",                       getCompanies);
router.post("/companies",                      createCompany);
router.post("/companies/:id/super-admin",      createCompanySuperAdmin);
router.put("/companies/:id/toggle",            toggleCompanyStatus);
router.get("/subscriptions",                   getSubscriptions);
router.put("/subscriptions/:companyId",        updateSubscription);

module.exports = router;