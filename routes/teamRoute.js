// routes/teamRoute.js — Team Lead feature (mounted at /api/team in server.js)
const express = require("express");
const router  = express.Router();
const { protect }      = require("../middlewares/authMiddleware");
const { protectAdmin } = require("../middlewares/adminAuthMiddleware");
const { validateObjectId } = require("../middlewares/validateObjectId");
const t = require("../controllers/teamController");

// ── Admin: build teams ───────────────────────────────────────────────────────
router.get("/admin/overview",                 protectAdmin, t.adminOverview);
router.put("/admin/users/:id/role",           protectAdmin, validateObjectId("id"), t.adminSetRole);
router.put("/admin/users/:id/team-lead",      protectAdmin, validateObjectId("id"), t.adminSetTeamLead);
router.put("/admin/team-leads/:id/members",   protectAdmin, validateObjectId("id"), t.adminSetMembers);

// ── Any employee: who is my team lead / am I one ─────────────────────────────
router.get("/me", protect, t.me);

// ── Team Lead only ───────────────────────────────────────────────────────────
router.get("/dashboard",  protect, t.requireTeamLead, t.dashboard);
router.get("/leads",      protect, t.requireTeamLead, t.teamLeads);
router.post("/reassign",  protect, t.requireTeamLead, t.reassign);
router.get("/attendance", protect, t.requireTeamLead, t.attendance);
router.get("/calls",      protect, t.requireTeamLead, t.calls);
router.post("/leads/:id/call",     protect, validateObjectId("id"), t.requireTeamLead, t.callLead);
router.post("/leads/:id/log-call", protect, validateObjectId("id"), t.requireTeamLead, t.logCall);

module.exports = router;
