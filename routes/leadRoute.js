// routes/leadRoute.js — Merge Number removed; Single Additional Phone Number system
const express = require("express");
const router = express.Router();

const {
  getLead,
  getLeads,
  getLeadsByCampaign,
  getDistinctCampaigns,
  createLead,
  adminCreateLead,
  adminCreateLeadsBulk,
  adminImportCSV,
  userImportCSV,
  updateLead,
  patchLead,
  patchLeadTemperature,
  markNotInterested,
  markColdReassign,
  deleteLead,
  adminUpdateLead,
  adminDeleteLead,
  closeLeadWrongEntry,
  getMyLeads,
  updateLeadEmail,
  bulkUpdateEmails,
  adminGetAllLeads,
  checkDuplicate,
  logPhoneReveal,
  getFollowUpAlerts,
  addSecondaryPhone,
  removeSecondaryPhone,
  swapPhones,
} = require("../controllers/leadController");

const { protect } = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");

// ── Duplicate-check endpoints (must come BEFORE /:id wildcard) ───────────────
router.get("/check-duplicate", protect, checkDuplicate);
router.get("/admin/check-duplicate", protectAdmin, checkDuplicate);

// ── Follow-up alert notification endpoints ────────────────────────────────────
router.get("/follow-up-alerts", protect, getFollowUpAlerts);
router.get("/admin/follow-up-alerts", protectAdmin, getFollowUpAlerts);

// ── RULE: All specific/named routes MUST come before wildcard /:id routes ─────

// ── GET ───────────────────────────────────────────────────────────────────────
router.get("/admin/all", protectAdmin, adminGetAllLeads);
router.get("/my-leads", protect, getMyLeads);
router.get("/by-campaign", protectAdmin, getLeadsByCampaign);
router.get("/distinct-campaigns", protectAdmin, getDistinctCampaigns);
router.get("/", protect, getLeads);
router.get("/:id", protect, getLead);

// ── POST ──────────────────────────────────────────────────────────────────────
router.post("/admin/create", protectAdmin, adminCreateLead);
router.post("/admin/bulk-create", protectAdmin, adminCreateLeadsBulk);
router.post("/admin/import-csv", protectAdmin, adminImportCSV);
router.patch("/admin/bulk-update-emails", protectAdmin, bulkUpdateEmails);
router.patch("/admin/update-email/:id", protectAdmin, updateLeadEmail);
router.post("/superadmin/create", protectSuperAdmin, adminCreateLead);
router.post("/superadmin/bulk-create", protectSuperAdmin, adminCreateLeadsBulk);
router.post("/import-csv", protect, userImportCSV);
router.post("/", protect, createLead);

// ── PATCH ─────────────────────────────────────────────────────────────────────
router.patch("/:id/not-interested", protect, markNotInterested);
router.patch("/:id/cold-reassign", protect, markColdReassign);

// ── Phone reveal tracking ────────────────────────────────────────────────────
router.post("/:id/reveal-phone", protect, logPhoneReveal);
router.post("/admin/:id/reveal-phone", protectAdmin, logPhoneReveal);

router.patch("/:id/temperature", protectAdmin, patchLeadTemperature);
router.patch("/:id", protect, patchLead);

// ── PUT ───────────────────────────────────────────────────────────────────────
router.put("/admin/:id", protectAdmin, adminUpdateLead);
router.put("/superadmin/:id", protectSuperAdmin, adminUpdateLead);
router.put("/:id", protect, updateLead);

// ── Close lead as wrong entry ─────────────────────────────────────────────────
router.patch("/admin/:id/close-wrong-entry", protectAdmin, closeLeadWrongEntry);

// ── Additional (secondary) phone number management ────────────────────────────
// Add/replace additional number
router.put("/:id/secondary-phone", protect, addSecondaryPhone);
router.put("/admin/:id/secondary-phone", protectAdmin, addSecondaryPhone);

// Remove additional number
router.delete("/:id/secondary-phone", protect, removeSecondaryPhone);
router.delete("/admin/:id/secondary-phone", protectAdmin, removeSecondaryPhone);

// Swap primary ↔ additional number
router.put("/:id/swap-phones", protect, swapPhones);
router.put("/admin/:id/swap-phones", protectAdmin, swapPhones);

// ── Additional (secondary) phone number management ────────────────────────────
router.put("/:id/secondary-phone",          protect,      addSecondaryPhone);
router.put("/admin/:id/secondary-phone",    protectAdmin, addSecondaryPhone);
router.delete("/:id/secondary-phone",       protect,      removeSecondaryPhone);
router.delete("/admin/:id/secondary-phone", protectAdmin, removeSecondaryPhone);
router.put("/:id/swap-phones",              protect,      swapPhones);
router.put("/admin/:id/swap-phones",        protectAdmin, swapPhones);

// ── DELETE ────────────────────────────────────────────────────────────────────
router.delete("/admin/:id", protectAdmin, adminDeleteLead);
router.delete("/superadmin/:id", protectSuperAdmin, adminDeleteLead);
router.delete("/:id", protect, deleteLead);

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
    if (!users.length)
      return res.status(400).json({ message: "No users in company" });

    const counts = await Promise.all(
      users.map((u) =>
        Lead.countDocuments({
          company: companyId,
          user: u._id,
          status: { $nin: ["Not Interested", "Converted"] },
        }).then((c) => ({ userId: u._id, count: c })),
      ),
    );
    counts.sort((a, b) => a.count - b.count);
    const nextUser = counts[0].userId;

    const updated = await Lead.findByIdAndUpdate(
      id,
      { user: nextUser },
      { new: true },
    ).populate("user", "name email");
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
    console.log(
      `🔥 HOT LEAD ALERT: leadId=${leadId} | score=${score} | ${summary}`,
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
