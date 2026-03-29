const express = require("express");
const router = express.Router();
const Lead = require("../models/Leads");
const { getLead, getLeads, createLead, updateLead, deleteLead, adminCreateLead } = require("../controllers/leadController");
const { protect } = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");

router.get("/:id", protect, getLead);

router.get("/", protect, getLeads);

// Regular user creating their own leads
router.post("/", protect, createLead);

// Admin creating a lead for their company
router.post("/admin/create", protectAdmin, adminCreateLead);

// SuperAdmin creating a lead (must pass companyId in body)
router.post("/superadmin/create", protectSuperAdmin, adminCreateLead);

router.delete("/:id", protect, deleteLead);

router.put("/:id", protect, updateLead);

module.exports = router;