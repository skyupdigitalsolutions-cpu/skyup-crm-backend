// routes/projectRoute.js — UPDATED
// Added requireFeature("projects") gate to all project routes (admin and user).
// Projects is an independent feature — does not depend on Tasks or any other module.

const express = require("express");
const router  = express.Router();

const {
  getProjects,
  getProjectsAdmin,
  createProject,
  createProjectAdmin,
  updateProject,
  updateProjectAdmin,
  deleteProjectAdmin,
} = require("../controllers/projectController");

const { protect }        = require("../middlewares/authMiddleware");
const { protectAdmin, requireCompanySuperAdmin }   = require("../middlewares/adminAuthMiddleware");
const { requireFeature } = require("../middlewares/entitlementMiddleware");

// ── Admin routes ─────────────────────────────────────────────────────────────
router.get   ("/admin",     protectAdmin, requireFeature("projects"), getProjectsAdmin);
router.post  ("/admin",     protectAdmin, requireFeature("projects"), createProjectAdmin);
router.put   ("/admin/:id", protectAdmin, requireFeature("projects"), updateProjectAdmin);
router.delete("/admin/:id", protectAdmin, requireCompanySuperAdmin, requireFeature("projects"), deleteProjectAdmin);

// ── User (employee) routes ────────────────────────────────────────────────────
// NOTE: project deletion is restricted to the company super_admin only,
// so there is no employee-level delete route.
router.get   ("/",    protect, requireFeature("projects"), getProjects);
router.post  ("/",    protect, requireFeature("projects"), createProject);
router.put   ("/:id", protect, requireFeature("projects"), updateProject);

module.exports = router;