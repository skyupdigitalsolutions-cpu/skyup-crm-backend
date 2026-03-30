const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const {
  getMyCompany,
  getAdmin,
  getAdmins,
  createAdmin,
  deleteAdmin,
  updateAdmin,
  getCompanyUsers,
  getCompanyLeads,
} = adminController;
const {
  registerAdmin,
  loginAdmin,
} = require("../controllers/adminAuthController");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { authLimiter } = require("../middlewares/rateLimiter");

// Auth (public)
router.post("/register", authLimiter, registerAdmin);
router.post("/login", authLimiter, loginAdmin);

// Company specific routes (must be before /:id to avoid conflict)
router.get("/company/me",    protectAdmin, getMyCompany || ((req, res) => res.status(501).json({ message: "Not implemented" })));
router.get("/company/users", protectAdmin, getCompanyUsers);
router.get("/company/leads", protectAdmin, getCompanyLeads);

// Admin CRUD (protected)
router.get("/", protectAdmin, getAdmins);
router.get("/:id", protectAdmin, getAdmin);
router.post("/", protectAdmin, createAdmin);
router.delete("/:id", protectAdmin, deleteAdmin);
router.put("/:id", protectAdmin, updateAdmin);

module.exports = router;