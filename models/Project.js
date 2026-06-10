// models/Project.js
const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema(
  {
    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    // Optional description / notes for the project
    description: {
      type:    String,
      default: "",
      trim:    true,
    },

    // Display color (hex string, e.g. "#2563EB")
    color: {
      type:    String,
      default: "#2563EB",
      trim:    true,
    },

    // Company this project belongs to
    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
    },

    // ── Creator tracking ──────────────────────────────────────────────────────
    // Exactly one of these will be set depending on who created the project.
    createdByAdmin: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Admin",
      default: null,
    },
    createdByUser: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },

    // ── Visibility flag ───────────────────────────────────────────────────────
    // true  → visible to everyone in the company (or all employees if created by employee)
    // false → visible only to the creator (or admins if created by admin)
    isGlobal: {
      type:    Boolean,
      default: false,
    },

    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Index for fast company-scoped lookups
projectSchema.index({ company: 1 });
projectSchema.index({ company: 1, isActive: 1 });

const Project = mongoose.model("Project", projectSchema);
module.exports = Project;
