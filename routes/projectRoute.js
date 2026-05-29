// routes/projectRoute.js
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

const { protect }      = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");

// ── Admin routes ─────────────────────────────────────────────────────────────
router.get   ("/admin",     protectAdmin, getProjectsAdmin);
router.post  ("/admin",     protectAdmin, createProjectAdmin);
router.put   ("/admin/:id", protectAdmin, updateProjectAdmin);
router.delete("/admin/:id", protectAdmin, deleteProjectAdmin);

// ── User (employee) routes ────────────────────────────────────────────────────
router.get   ("/",    protect, getProjects);
router.post  ("/",    protect, createProject);
router.put   ("/:id", protect, updateProject);
router.delete("/:id", protect, deleteProject);

module.exports = router;
