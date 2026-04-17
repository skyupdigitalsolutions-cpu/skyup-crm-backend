const express = require("express");
const router  = express.Router();

const {
  getLead, getLeads, getLeadsByCampaign,
  createLead, adminCreateLead, adminCreateLeadsBulk,
  adminImportCSV, userImportCSV,
  updateLead, patchLead, patchLeadTemperature,
  markNotInterested,
  deleteLead, adminUpdateLead, adminDeleteLead,
  getMyLeads,
  updateLeadEmail, bulkUpdateEmails,
} = require("../controllers/leadController");

const { protect }           = require("../middlewares/authMiddleware");
const { protectAdmin }      = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");

// ── RULE: All specific/named routes MUST come before wildcard /:id routes ─────

// ── GET ───────────────────────────────────────────────────────────────────────
router.get("/my-leads",    protect,      getMyLeads);
router.get("/by-campaign", protectAdmin, getLeadsByCampaign);
router.get("/",            protect,      getLeads);
router.get("/:id",         protect,      getLead);

// ── POST ──────────────────────────────────────────────────────────────────────
// Admin: create single / bulk / import CSV (round-robin)
router.post("/admin/create",           protectAdmin,      adminCreateLead);
router.post("/admin/bulk-create",      protectAdmin,      adminCreateLeadsBulk);
router.post("/admin/import-csv",       protectAdmin,      adminImportCSV);
// Admin: email update routes
router.patch("/admin/bulk-update-emails", protectAdmin,   bulkUpdateEmails);
router.patch("/admin/update-email/:id",   protectAdmin,   updateLeadEmail);
// SuperAdmin equivalents
router.post("/superadmin/create",      protectSuperAdmin, adminCreateLead);
router.post("/superadmin/bulk-create", protectSuperAdmin, adminCreateLeadsBulk);
// User: create / import CSV (auto-assigns to self)
router.post("/import-csv",             protect,           userImportCSV);
router.post("/",                       protect,           createLead);

// ── PATCH ─────────────────────────────────────────────────────────────────────
router.patch("/:id/not-interested", protect, markNotInterested);   // NEW
router.patch("/:id/temperature",    protect, patchLeadTemperature); // before /:id
router.patch("/:id",                protect, patchLead);

// ── PUT ───────────────────────────────────────────────────────────────────────
router.put("/admin/:id",      protectAdmin,      adminUpdateLead);
router.put("/superadmin/:id", protectSuperAdmin, adminUpdateLead);
router.put("/:id",            protect,           updateLead);

// ── DELETE ────────────────────────────────────────────────────────────────────
router.delete("/admin/:id",      protectAdmin,      adminDeleteLead);
router.delete("/superadmin/:id", protectSuperAdmin, adminDeleteLead);
router.delete("/:id",            protect,           deleteLead);

module.exports = router;