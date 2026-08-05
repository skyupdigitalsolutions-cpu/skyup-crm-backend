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
  markInvalid,
  deleteLead,
  adminUpdateLead,
  adminDeleteLead,
  closeLeadWrongEntry,
  closeLeadByUser,
  getMyLeads,
  updateLeadEmail,
  bulkUpdateEmails,
  adminGetAllLeads,
  checkDuplicate,
  logPhoneReveal,
  logEmailReveal,
  getFollowUpAlerts,
  getPendingNotifications,
  addSecondaryPhone,
  removeSecondaryPhone,
  swapPhones,
  mergeLead,
  getLeadActionSummary,
} = require("../controllers/leadController");

const { protect } = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { protectSuperAdmin } = require("../middlewares/superAdminMiddleware");
const { checkLimit } = require("../middlewares/entitlementMiddleware");
const Lead = require("../models/Leads");

// Shared lead count function — counts all leads for the company
const countCompanyLeads = async (req) => {
  const companyId =
    req.admin?.company?._id || req.admin?.company ||
    req.user?.company?._id  || req.user?.company  || null;
  if (!companyId) return 0;
  return Lead.countDocuments({ company: companyId });
};

// ── Duplicate-check endpoints (must come BEFORE /:id wildcard) ───────────────
router.get("/check-duplicate", protect, checkDuplicate);
router.get("/admin/check-duplicate", protectAdmin, checkDuplicate);

// ── Follow-up alert notification endpoints ────────────────────────────────────
router.get("/follow-up-alerts", protect, getFollowUpAlerts);
router.get("/admin/follow-up-alerts", protectAdmin, getFollowUpAlerts);
// Bell fetch-on-open: current pending no-action + follow-up notifications.
router.get("/admin/pending-notifications", protectAdmin, getPendingNotifications);

// ── RULE: All specific/named routes MUST come before wildcard /:id routes ─────

// ── GET ───────────────────────────────────────────────────────────────────────
router.get("/admin/all", protectAdmin, adminGetAllLeads);
router.get("/my-leads", protect, getMyLeads);
router.get("/by-campaign", protectAdmin, getLeadsByCampaign);
router.get("/distinct-campaigns", protectAdmin, getDistinctCampaigns);
router.get("/", protect, getLeads);
// AI action summary (employee + admin) — must precede the /:id wildcard
router.get("/:id/action-summary", protect, validateObjectId("id"), getLeadActionSummary);
router.get("/admin/:id/action-summary", protectAdmin, validateObjectId("id"), getLeadActionSummary);
router.get("/:id", protect, validateObjectId("id"), getLead);

// ── POST ──────────────────────────────────────────────────────────────────────
router.post("/admin/create",      protectAdmin,      checkLimit("leads", countCompanyLeads), adminCreateLead);
router.post("/admin/bulk-create", protectAdmin,      checkLimit("leads", countCompanyLeads), adminCreateLeadsBulk);
router.post("/admin/import-csv",  protectAdmin,      checkLimit("leads", countCompanyLeads), adminImportCSV);
router.patch("/admin/bulk-update-emails", protectAdmin, bulkUpdateEmails);
router.patch("/admin/update-email/:id", protectAdmin, validateObjectId("id"), updateLeadEmail);
router.post("/superadmin/create",      protectSuperAdmin, checkLimit("leads", countCompanyLeads), adminCreateLead);
router.post("/superadmin/bulk-create", protectSuperAdmin, checkLimit("leads", countCompanyLeads), adminCreateLeadsBulk);
router.post("/import-csv", protect, checkLimit("leads", countCompanyLeads), userImportCSV);
router.post("/",           protect, checkLimit("leads", countCompanyLeads), createLead);

// ── PATCH ─────────────────────────────────────────────────────────────────────
router.patch("/:id/not-interested", protect, validateObjectId("id"), markNotInterested);
router.patch("/:id/cold-reassign", protect, validateObjectId("id"), markColdReassign);
router.patch("/:id/invalid", protect, validateObjectId("id"), markInvalid);

// ── Phone reveal tracking ────────────────────────────────────────────────────
router.post("/:id/reveal-phone", protect, validateObjectId("id"), logPhoneReveal);
router.post("/admin/:id/reveal-phone", protectAdmin, validateObjectId("id"), logPhoneReveal);

// ── Email reveal tracking ────────────────────────────────────────────────────
router.post("/:id/reveal-email", protect, validateObjectId("id"), logEmailReveal);
router.post("/admin/:id/reveal-email", protectAdmin, validateObjectId("id"), logEmailReveal);

router.patch("/:id/temperature", protectAdmin, validateObjectId("id"), patchLeadTemperature);
router.patch("/:id", protect, validateObjectId("id"), patchLead);

// ── PUT ───────────────────────────────────────────────────────────────────────
router.put("/admin/:id", protectAdmin, validateObjectId("id"), adminUpdateLead);
router.put("/superadmin/:id", protectSuperAdmin, validateObjectId("id"), adminUpdateLead);
router.put("/:id", protect, validateObjectId("id"), updateLead);

// ── Close lead as wrong entry ─────────────────────────────────────────────────
router.patch("/admin/:id/close-wrong-entry", protectAdmin, validateObjectId("id"), closeLeadWrongEntry);
router.patch("/:id/close-wrong-entry",       protect, validateObjectId("id"),      closeLeadWrongEntry); // employee-level (own leads only)
// Employee closes a lead with phone number + remark → notifies admin
router.post("/:id/close-by-user", protect, validateObjectId("id"), closeLeadByUser);

// ── Additional (secondary) phone number management ────────────────────────────
// Add/replace additional number
router.put("/:id/secondary-phone", protect, validateObjectId("id"), addSecondaryPhone);
router.put("/admin/:id/secondary-phone", protectAdmin, validateObjectId("id"), addSecondaryPhone);
router.put("/superadmin/:id/secondary-phone", protectSuperAdmin, validateObjectId("id"), addSecondaryPhone);

// Remove additional number
router.delete("/:id/secondary-phone", protect, validateObjectId("id"), removeSecondaryPhone);
router.delete("/admin/:id/secondary-phone", protectAdmin, validateObjectId("id"), removeSecondaryPhone);
router.delete("/superadmin/:id/secondary-phone", protectSuperAdmin, validateObjectId("id"), removeSecondaryPhone);

// Swap primary ↔ additional number
router.put("/:id/swap-phones", protect, validateObjectId("id"), swapPhones);
router.put("/admin/:id/swap-phones", protectAdmin, validateObjectId("id"), swapPhones);
router.put("/superadmin/:id/swap-phones", protectSuperAdmin, validateObjectId("id"), swapPhones);

// ── Merge duplicate leads (add incoming number as secondary of target lead) ───
router.post("/admin/:id/merge", protectAdmin, validateObjectId("id"), mergeLead);
router.post("/superadmin/:id/merge", protectSuperAdmin, validateObjectId("id"), mergeLead);
router.post("/:id/merge", protect, validateObjectId("id"), mergeLead);

// ── DELETE ────────────────────────────────────────────────────────────────────
router.delete("/admin/:id", protectAdmin, validateObjectId("id"), adminDeleteLead);
router.delete("/superadmin/:id", protectSuperAdmin, validateObjectId("id"), adminDeleteLead);
router.delete("/:id", protect, validateObjectId("id"), deleteLead);

// ── PATCH /admin/:id/assign-roundrobin ───────────────────────────────────────
// Called by useVoicebot after a Warm result — reassigns lead round-robin
router.patch("/admin/:id/assign-roundrobin", protectAdmin, validateObjectId("id"), async (req, res) => {
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

// ── Client Meeting Remarks ─────────────────────────────────────────────────────
const { addMeetingRemark, getMeetingRemarks, sendMeetingWhatsApp } = require('../controllers/meetingRemarkController');
// Employee routes
router.post('/:id/meeting-remark',   protect, addMeetingRemark);
router.get('/:id/meeting-remarks',   protect, getMeetingRemarks);
router.post('/:id/meeting-whatsapp', protect, sendMeetingWhatsApp);
// Admin routes
router.post('/admin/:id/meeting-remark',   protectAdmin, addMeetingRemark);
router.get('/admin/:id/meeting-remarks',   protectAdmin, getMeetingRemarks);
router.post('/admin/:id/meeting-whatsapp', protectAdmin, sendMeetingWhatsApp);

module.exports = router;