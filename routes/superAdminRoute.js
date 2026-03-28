// routes/superAdminRoute.js
const express = require("express");
const router = express.Router();
const {
  registerSuperAdmin,
  loginSuperAdmin,
  createCompany,
  getCompanies,
  getCompany,
  toggleCompany,
  deleteCompany,
  getDashboardStats,
} = require("../controllers/superAdminController");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");
const { authLimiter } = require("../middlewares/rateLimiter");

// Auth (public)
router.post("/register", authLimiter, registerSuperAdmin); // Run once only!
router.post("/login", authLimiter, loginSuperAdmin);

// Dashboard (protected)
router.get("/dashboard", protectSuperAdmin, getDashboardStats);

// Company management (protected)
router.get("/companies", protectSuperAdmin, getCompanies);
router.post("/companies", protectSuperAdmin, createCompany);
router.get("/companies/:id", protectSuperAdmin, getCompany);
router.put("/companies/:id", protectSuperAdmin, toggleCompany);
router.delete("/companies/:id", protectSuperAdmin, deleteCompany);

module.exports = router;
