// controllers/projectController.js
const Project = require("../models/Project");
const Lead    = require("../models/Leads");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**a
 * Build the Mongo query filter that applies project visibility rules:
 *
 *  Creator      | isGlobal | Visible to
 * --------------|----------|-----------------------------
 *  Admin        | true     | Everyone in company
 *  Admin        | false    | Admins only
 *  Employee     | false    | That employee only
 *  Employee     | true     | All employees + admins
 */
function buildVisibilityFilter({ company, adminId, userId }) {
  const base = { company, isActive: true };

  if (adminId) {
    // Admin sees: all admin-created projects + all isGlobal employee projects
    return {
      ...base,
      $or: [
        { createdByAdmin: { $ne: null } },          // every admin-created project
        { createdByUser: { $ne: null }, isGlobal: true }, // globally shared employee projects
      ],
    };
  }

  if (userId) {
    // Employee sees: their own projects + globally shared projects (any creator)
    return {
      ...base,
      $or: [
        { createdByUser: userId },       // their own
        { isGlobal: true },              // any global project (admin or employee)
      ],
    };
  }

  // Fallback — should not happen
  return base;
}

// ── GET /api/project  (user route) ───────────────────────────────────────────
exports.getProjects = async (req, res) => {
  try {
    const company = req.user?.company;
    const userId  = req.user?._id;

    if (!company || !userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const filter   = buildVisibilityFilter({ company, userId });
    const projects = await Project.find(filter).sort({ createdAt: -1 });
    res.json(projects);
  } catch (err) {
    console.error("getProjects error:", err);
    res.status(500).json({ message: "Failed to fetch projects" });
  }
};

// ── GET /api/project/admin  (admin route) ────────────────────────────────────
exports.getProjectsAdmin = async (req, res) => {
  try {
    const company = req.admin?.company;
    const adminId = req.admin?._id;

    if (!company || !adminId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const filter   = buildVisibilityFilter({ company, adminId });
    const projects = await Project.find(filter).sort({ createdAt: -1 });
    res.json(projects);
  } catch (err) {
    console.error("getProjectsAdmin error:", err);
    res.status(500).json({ message: "Failed to fetch projects" });
  }
};

// ── POST /api/project  (user route) ──────────────────────────────────────────
exports.createProject = async (req, res) => {
  try {
    const { name, color, isGlobal, description } = req.body;
    const company = req.user?.company;
    const userId  = req.user?._id;

    if (!company || !userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!name?.trim()) {
      return res.status(400).json({ message: "Project name is required" });
    }

    const project = await Project.create({
      name:          name.trim(),
      description:   (description || "").trim(),
      color:         color || "#2563EB",
      company,
      createdByUser: userId,
      isGlobal:      Boolean(isGlobal),
    });

    res.status(201).json(project);
  } catch (err) {
    console.error("createProject error:", err);
    res.status(500).json({ message: "Failed to create project" });
  }
};

// ── POST /api/project/admin  (admin route) ───────────────────────────────────
exports.createProjectAdmin = async (req, res) => {
  try {
    const { name, color, isGlobal, description } = req.body;
    const company = req.admin?.company;
    const adminId = req.admin?._id;

    if (!company || !adminId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!name?.trim()) {
      return res.status(400).json({ message: "Project name is required" });
    }

    const project = await Project.create({
      name:           name.trim(),
      description:    (description || "").trim(),
      color:          color || "#2563EB",
      company,
      createdByAdmin: adminId,
      isGlobal:       isGlobal === false ? false : true,
    });

    res.status(201).json(project);
  } catch (err) {
    console.error("createProjectAdmin error:", err);
    res.status(500).json({ message: "Failed to create project" });
  }
};

// ── PUT /api/project/:id  (user route) ───────────────────────────────────────
exports.updateProject = async (req, res) => {
  try {
    const { id }       = req.params;
    const { name, color, isGlobal, isActive } = req.body;
    const company      = req.user?.company;
    const userId       = req.user?._id;

    const project = await Project.findOne({ _id: id, company, createdByUser: userId });
    if (!project) {
      return res.status(404).json({ message: "Project not found or not authorized" });
    }

    if (name?.trim())           project.name     = name.trim();
    if (color)                  project.color    = color;
    if (isGlobal !== undefined) project.isGlobal = Boolean(isGlobal);
    if (isActive !== undefined) project.isActive = Boolean(isActive);

    await project.save();
    res.json(project);
  } catch (err) {
    console.error("updateProject error:", err);
    res.status(500).json({ message: "Failed to update project" });
  }
};

// ── PUT /api/project/admin/:id  (admin route) ────────────────────────────────
exports.updateProjectAdmin = async (req, res) => {
  try {
    const { id }       = req.params;
    const { name, color, isGlobal, isActive, description } = req.body;
    const company      = req.admin?.company;

    const project = await Project.findOne({ _id: id, company });
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    if (name?.trim())           project.name        = name.trim();
    if (description !== undefined) project.description = (description || "").trim();
    if (color)                  project.color       = color;
    if (isGlobal !== undefined) project.isGlobal    = Boolean(isGlobal);
    if (isActive !== undefined) project.isActive    = Boolean(isActive);

    await project.save();
    res.json(project);
  } catch (err) {
    console.error("updateProjectAdmin error:", err);
    res.status(500).json({ message: "Failed to update project" });
  }
};

// ── DELETE /api/project/:id  (user route) ────────────────────────────────────
exports.deleteProject = async (req, res) => {
  try {
    const { id }  = req.params;
    const company = req.user?.company;
    const userId  = req.user?._id;

    const project = await Project.findOneAndDelete({ _id: id, company, createdByUser: userId });
    if (!project) {
      return res.status(404).json({ message: "Project not found or not authorized" });
    }

    // Remove project reference from all leads in this company
    await Lead.updateMany(
      { company, projects: id },
      { $pull: { projects: id } }
    );

    res.json({ message: "Project deleted" });
  } catch (err) {
    console.error("deleteProject error:", err);
    res.status(500).json({ message: "Failed to delete project" });
  }
};

// ── DELETE /api/project/admin/:id  (admin route) ─────────────────────────────
exports.deleteProjectAdmin = async (req, res) => {
  try {
    const { id }  = req.params;
    const company = req.admin?.company;

    const project = await Project.findOneAndDelete({ _id: id, company });
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // Remove project reference from all leads in this company
    await Lead.updateMany(
      { company, projects: id },
      { $pull: { projects: id } }
    );

    res.json({ message: "Project deleted" });
  } catch (err) {
    console.error("deleteProjectAdmin error:", err);
    res.status(500).json({ message: "Failed to delete project" });
  }
};
