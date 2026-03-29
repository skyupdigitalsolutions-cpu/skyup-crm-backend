const express = require("express");
const router = express.Router();
const { getLead, getLeads, getLeadsByCampaign, createLead, updateLead, deleteLead, adminCreateLead } = require("../controllers/leadController");
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

// SuperAdmin creating a lead (must pass companyId in body)
router.post("/superadmin/create", protectSuperAdmin, adminCreateLead);

router.delete("/:id", protect, deleteLead);
router.put("/:id", protect, updateLead);

module.exports = router;