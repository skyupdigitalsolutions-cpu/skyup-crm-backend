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

// TEMPORARY ROUTE - DELETE AFTER USE
router.post("/register", async (req, res) => {
  try {
    const Developer = require("../models/Developer");
    const { name, email, password } = req.body;
    const exists = await Developer.findOne({ email });
    if (exists) return res.status(400).json({ message: "Already exists" });
    const dev = await Developer.create({ name, email, password });
    res.status(201).json({ message: "Developer created", email: dev.email });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

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