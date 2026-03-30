const express = require("express");
const router = express.Router();
const { getLead, getLeads, getLeadsByCampaign, createLead, updateLead, deleteLead, adminCreateLead, adminCreateLeadsBulk, adminUpdateLead, adminDeleteLead } = require("../controllers/leadController");
const { protect } = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");

// ── "/" must come BEFORE "/:id" to avoid Express matching "/" as an id ──────
router.get("/", protect, getLeads);

// Admin fetches leads by campaign name (used in LeadDrawer on Campaigns page)
router.get("/by-campaign", protectAdmin, getLeadsByCampaign);

router.get("/:id", protect, getLead);

// Regular user creating their own leads
router.post("/", protect, createLead);

// Admin creating a lead for their company
router.post("/admin/create", protectAdmin, adminCreateLead);

// Admin bulk-creating leads for their company (up to 50 at once)
router.post("/admin/bulk-create", protectAdmin, adminCreateLeadsBulk);

// SuperAdmin bulk-creating leads (must pass companyId in body)
router.post("/superadmin/bulk-create", protectSuperAdmin, adminCreateLeadsBulk);

// SuperAdmin creating a lead (must pass companyId in body)
router.post("/superadmin/create", protectSuperAdmin, adminCreateLead);

router.delete("/:id", protect, deleteLead);
router.put("/:id", protect, updateLead);

// Admin / SuperAdmin update and delete (used from the Report Page dashboard)
router.put("/admin/:id", protectAdmin, adminUpdateLead);
router.delete("/admin/:id", protectAdmin, adminDeleteLead);
router.put("/superadmin/:id", protectSuperAdmin, adminUpdateLead);
router.delete("/superadmin/:id", protectSuperAdmin, adminDeleteLead);

module.exports = router;