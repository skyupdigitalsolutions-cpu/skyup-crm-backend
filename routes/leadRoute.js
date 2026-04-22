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
  adminGetAllLeads,
} = require("../controllers/leadController");

const { protect }           = require("../middlewares/authMiddleware");
const { protectAdmin }      = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");

// ── RULE: All specific/named routes MUST come before wildcard /:id routes ─────

// ── GET ───────────────────────────────────────────────────────────────────────
router.get("/admin/all",   protectAdmin, adminGetAllLeads); // all company leads for admin
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
router.patch("/:id/temperature",    protectAdmin, patchLeadTemperature); // voicebot uses admin token
router.patch("/:id",                protect, patchLead);

// ── PUT ───────────────────────────────────────────────────────────────────────
router.put("/admin/:id",      protectAdmin,      adminUpdateLead);
router.put("/superadmin/:id", protectSuperAdmin, adminUpdateLead);
router.put("/:id",            protect,           updateLead);

// ── DELETE ────────────────────────────────────────────────────────────────────
router.delete("/admin/:id",      protectAdmin,      adminDeleteLead);
router.delete("/superadmin/:id", protectSuperAdmin, adminDeleteLead);
router.delete("/:id",            protect,           deleteLead);

// ── PATCH /admin/:id/assign-roundrobin ───────────────────────────────────────
// Called by useVoicebot after a Warm result — reassigns lead round-robin
router.patch("/admin/:id/assign-roundrobin", protectAdmin, async (req, res) => {
  try {
    const Lead = require("../models/Leads");
    const User = require("../models/Users");
    const { id } = req.params;
    const companyId = req.admin?.company?._id || req.admin?.company;

    const lead = await Lead.findOne({ _id: id, company: companyId });
    if (!lead) return res.status(404).json({ message: "Lead Not Found" });

    const users = await User.find({ company: companyId }).select("_id").lean();
    if (!users.length) return res.status(400).json({ message: "No users in company" });

    const counts = await Promise.all(
      users.map(u =>
        Lead.countDocuments({ company: companyId, user: u._id, status: { $nin: ["Not Interested", "Converted"] } })
          .then(c => ({ userId: u._id, count: c }))
      )
    );
    counts.sort((a, b) => a.count - b.count);
    const nextUser = counts[0].userId;

    const updated = await Lead.findByIdAndUpdate(id, { user: nextUser }, { new: true })
      .populate("user", "name email");
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /admin/notify-hot ────────────────────────────────────────────────────
// Called by useVoicebot after a Hot result — log + optional notification
router.post("/admin/notify-hot", protectAdmin, async (req, res) => {
  try {
    const { leadId, score, summary } = req.body;
    console.log(`🔥 HOT LEAD ALERT: leadId=${leadId} | score=${score} | ${summary}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;