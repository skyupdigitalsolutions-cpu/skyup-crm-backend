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
  deleteProject,
  deleteProjectAdmin,
} = require("../controllers/projectController");

const { protect }        = require("../middlewares/authMiddleware");
const { protectAdmin }   = require("../middlewares/adminAuthMiddleware");
const { requireFeature } = require("../middlewares/entitlementMiddleware");

// ── Admin routes ─────────────────────────────────────────────────────────────
router.get   ("/admin",     protectAdmin, requireFeature("projects"), getProjectsAdmin);
router.post  ("/admin",     protectAdmin, requireFeature("projects"), createProjectAdmin);
router.put   ("/admin/:id", protectAdmin, requireFeature("projects"), updateProjectAdmin);
router.delete("/admin/:id", protectAdmin, requireFeature("projects"), deleteProjectAdmin);

// ── User (employee) routes ────────────────────────────────────────────────────
router.get   ("/",    protect, requireFeature("projects"), getProjects);
router.post  ("/",    protect, requireFeature("projects"), createProject);
router.put   ("/:id", protect, requireFeature("projects"), updateProject);
router.delete("/:id", protect, requireFeature("projects"), deleteProject);

module.exports = router;
