const express = require("express");
const router  = express.Router();

const {
  getLead, getLeads, getLeadsByCampaign,
  createLead, adminCreateLead, adminCreateLeadsBulk,
  updateLead, patchLead, patchLeadTemperature,
  deleteLead, adminUpdateLead, adminDeleteLead,
  getMyLeads,
} = require("../controllers/leadController");

const { protect }          = require("../middlewares/authMiddleware");
const { protectAdmin }     = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin} = require("../middlewares/superAdminMiddleware");

// ── RULE: All specific/named routes MUST come before wildcard /:id routes ─────

// ── GET ───────────────────────────────────────────────────────────────────────
router.get("/my-leads",    protect,          getMyLeads);         // ✅ NEW: user sees only their leads
router.get("/by-campaign", protectAdmin,     getLeadsByCampaign); // must be before /:id
router.get("/",            protect,          getLeads);
router.get("/:id",         protect,          getLead);

// ── POST ──────────────────────────────────────────────────────────────────────
router.post("/admin/create",          protectAdmin,      adminCreateLead);
router.post("/admin/bulk-create",     protectAdmin,      adminCreateLeadsBulk);
router.post("/superadmin/create",     protectSuperAdmin, adminCreateLead);
router.post("/superadmin/bulk-create",protectSuperAdmin, adminCreateLeadsBulk);
router.post("/",                      protect,           createLead);

// ── PATCH ─────────────────────────────────────────────────────────────────────
// ✅ NEW: PATCH /lead/:id          → update status + remark (user)
// ✅ NEW: PATCH /lead/:id/temperature → update temperature only (user)
router.patch("/:id/temperature", protect, patchLeadTemperature); // must be before /:id
router.patch("/:id",             protect, patchLead);

// ── PUT ───────────────────────────────────────────────────────────────────────
router.put("/admin/:id",      protectAdmin,      adminUpdateLead);
router.put("/superadmin/:id", protectSuperAdmin, adminUpdateLead);
router.put("/:id",            protect,           updateLead);

// ── DELETE ────────────────────────────────────────────────────────────────────
router.delete("/admin/:id",      protectAdmin,      adminDeleteLead);
router.delete("/superadmin/:id", protectSuperAdmin, adminDeleteLead);
router.delete("/:id",            protect,           deleteLead);

module.exports = router;