const express = require("express");
const router = express.Router();
const { getLead, getLeads, getLeadsByCampaign, createLead, updateLead, deleteLead, adminCreateLead, adminCreateLeadsBulk, adminUpdateLead, adminDeleteLead } = require("../controllers/leadController");
const { protect } = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");

// ── RULE: All specific/named routes MUST come before wildcard /:id routes ─────
// Express matches routes in registration order. If /:id is registered first,
// PUT /admin/someId and DELETE /admin/someId will never be reached because
// Express matches /:id with id="admin" and calls the wrong handler.

// ── GET ───────────────────────────────────────────────────────────────────────
router.get("/", protect, getLeads);
router.get("/by-campaign", protectAdmin, getLeadsByCampaign); // must be before /:id
router.get("/:id", protect, getLead);

// ── POST ──────────────────────────────────────────────────────────────────────
router.post("/admin/create", protectAdmin, adminCreateLead);           // before /:id
router.post("/admin/bulk-create", protectAdmin, adminCreateLeadsBulk); // before /:id
router.post("/superadmin/create", protectSuperAdmin, adminCreateLead);
router.post("/superadmin/bulk-create", protectSuperAdmin, adminCreateLeadsBulk);
router.post("/", protect, createLead);

// ── PUT ───────────────────────────────────────────────────────────────────────
// FIXED: /admin/:id and /superadmin/:id MUST come before /:id
// Previously /:id was registered first → PUT /admin/someId matched /:id with
// id="admin", calling user updateLead instead of adminUpdateLead → 404 always.
router.put("/admin/:id", protectAdmin, adminUpdateLead);
router.put("/superadmin/:id", protectSuperAdmin, adminUpdateLead);
router.put("/:id", protect, updateLead);

// ── DELETE ────────────────────────────────────────────────────────────────────
// Same fix: specific named routes before wildcard
router.delete("/admin/:id", protectAdmin, adminDeleteLead);
router.delete("/superadmin/:id", protectSuperAdmin, adminDeleteLead);
router.delete("/:id", protect, deleteLead);

module.exports = router;