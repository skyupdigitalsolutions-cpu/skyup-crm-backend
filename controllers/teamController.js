// controllers/teamController.js
// ─────────────────────────────────────────────────────────────────────────────
// Team Lead feature.
//
// ADMIN side (protectAdmin) — set up teams:
//   GET  /api/team/admin/overview                → team leads, their members, unassigned employees
//   PUT  /api/team/admin/users/:id/role          { isTeamLead }          promote / demote
//   PUT  /api/team/admin/users/:id/team-lead     { teamLeadId | null }   move one employee
//   PUT  /api/team/admin/team-leads/:id/members  { memberIds: [] }       set a TL's whole team
//
// TEAM LEAD side (protect + must be isTeamLead) — run the team:
//   GET  /api/team/me                → { isTeamLead, teamLead, members[] }
//   GET  /api/team/dashboard         → per-member stats  (?from&to ISO, default today)
//   GET  /api/team/leads             → team leads (?member&status&search&page&limit&view)
//   POST /api/team/reassign          { leadIds[], toUserId, reason }
//   GET  /api/team/attendance        → members' attendance (?date=YYYY-MM-DD, default today)
//   GET  /api/team/calls             → members' call logs (?member&from&to&page)
//
// Everything is scoped to the caller's company and (for team leads) to their
// own team — enforced here on the server, never only in the UI.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const User = require("../models/Users");
const Lead = require("../models/Leads");
const Attendance = require("../models/Attendance");
const MobileCallLog = require("../models/MobileCallLog");
const custSvc = require("../services/customizationService");
const teamScope = require("../utils/teamScope");
const { maskLeadPII } = require("../utils/maskPhone");

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => !!v && mongoose.isValidObjectId(String(v));
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

function adminCompanyId(req) {
  return String(req.admin?.company?._id || req.admin?.company || "");
}
function employeeCompanyId(req) {
  return String(req.user?.company?._id || req.user?.company || req.user?.companyId || "");
}
function emit(room, event, payload) {
  try { global._io && global._io.to(room).emit(event, payload); } catch { /* ignore */ }
}
function notifyTeamChanged(companyId, userIds = []) {
  teamScope.invalidateTeam(companyId);
  for (const id of userIds) emit(`agent:${id}`, "team_updated", { at: Date.now() });
  emit(`company_admin:${companyId}`, "team_updated", { at: Date.now() });
}

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN
// ═════════════════════════════════════════════════════════════════════════════

/** Users this admin may manage (super_admin → whole company). */
function adminUserFilter(req, extra = {}) {
  const q = { company: adminCompanyId(req), ...extra };
  if (req.admin?.role !== "super_admin") q.createdBy = req.admin._id;
  return q;
}

const adminOverview = async (req, res) => {
  try {
    const users = await User.find(adminUserFilter(req))
      .select("name email isTeamLead teamLead lastLoginAt createdBy")
      .sort({ name: 1 })
      .lean();
    const leads = users.filter((u) => u.isTeamLead);
    const teams = leads.map((tl) => ({
      teamLead: { _id: tl._id, name: tl.name, email: tl.email, lastLoginAt: tl.lastLoginAt },
      members: users
        .filter((u) => String(u.teamLead || "") === String(tl._id))
        .map((u) => ({ _id: u._id, name: u.name, email: u.email, lastLoginAt: u.lastLoginAt })),
    }));
    const tlIds = new Set(leads.map((l) => String(l._id)));
    const unassigned = users
      .filter((u) => !u.isTeamLead && !(u.teamLead && tlIds.has(String(u.teamLead))))
      .map((u) => ({ _id: u._id, name: u.name, email: u.email, lastLoginAt: u.lastLoginAt }));
    return res.json({ success: true, teams, unassigned });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const adminSetRole = async (req, res) => {
  try {
    const companyId = adminCompanyId(req);
    const makeTL = !!req.body?.isTeamLead;
    const user = await User.findOne(adminUserFilter(req, { _id: req.params.id }));
    if (!user) return res.status(404).json({ message: "Employee not found (or not in your team)." });

    if (makeTL) {
      user.isTeamLead = true;
      user.teamLead = null; // a Team Lead doesn't report to another Team Lead
      await user.save();
      notifyTeamChanged(companyId, [user._id]);
      return res.json({ success: true, message: `${user.name} is now a Team Lead.`, user: { _id: user._id, isTeamLead: true, teamLead: null } });
    }

    // Demote → members go back to reporting to the admin directly.
    const freed = await User.find({ company: companyId, teamLead: user._id }).select("_id").lean();
    await User.updateMany({ company: companyId, teamLead: user._id }, { $set: { teamLead: null } });
    user.isTeamLead = false;
    await user.save();
    notifyTeamChanged(companyId, [user._id, ...freed.map((f) => f._id)]);
    return res.json({
      success: true,
      message: `${user.name} is no longer a Team Lead. ${freed.length} member(s) now report to the admin.`,
      user: { _id: user._id, isTeamLead: false },
      freedMembers: freed.length,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

async function validateTeamLead(req, teamLeadId) {
  const tl = await User.findOne(adminUserFilter(req, { _id: teamLeadId, isTeamLead: true }))
    .select("_id name createdBy").lean();
  return tl;
}

const adminSetTeamLead = async (req, res) => {
  try {
    const companyId = adminCompanyId(req);
    const { teamLeadId } = req.body || {};
    const user = await User.findOne(adminUserFilter(req, { _id: req.params.id }));
    if (!user) return res.status(404).json({ message: "Employee not found (or not in your team)." });
    if (user.isTeamLead) return res.status(400).json({ message: "A Team Lead can't report to another Team Lead." });

    const prevTl = user.teamLead ? String(user.teamLead) : null;
    if (!teamLeadId) {
      user.teamLead = null;
    } else {
      if (!isId(teamLeadId)) return res.status(400).json({ message: "Invalid team lead." });
      const tl = await validateTeamLead(req, teamLeadId);
      if (!tl) return res.status(404).json({ message: "Team Lead not found." });
      if (req.admin?.role !== "super_admin" && String(tl.createdBy || "") !== String(user.createdBy || "")) {
        return res.status(400).json({ message: "Team Lead and employee must belong to the same admin." });
      }
      user.teamLead = tl._id;
    }
    await user.save();
    notifyTeamChanged(companyId, [user._id, prevTl, user.teamLead].filter(Boolean));
    return res.json({ success: true, user: { _id: user._id, teamLead: user.teamLead } });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const adminSetMembers = async (req, res) => {
  try {
    const companyId = adminCompanyId(req);
    const tl = await validateTeamLead(req, req.params.id);
    if (!tl) return res.status(404).json({ message: "Team Lead not found." });
    const ids = (Array.isArray(req.body?.memberIds) ? req.body.memberIds : []).filter(isId).map(String);

    const candidates = ids.length
      ? await User.find(adminUserFilter(req, { _id: { $in: ids } })).select("_id isTeamLead createdBy").lean()
      : [];
    const bad = candidates.filter((u) => u.isTeamLead || String(u._id) === String(tl._id));
    if (bad.length) return res.status(400).json({ message: "Team Leads can't be members of another team." });
    if (req.admin?.role !== "super_admin") {
      const wrong = candidates.filter((u) => String(u.createdBy || "") !== String(tl.createdBy || ""));
      if (wrong.length) return res.status(400).json({ message: "All members must belong to the same admin as the Team Lead." });
    }
    const validIds = candidates.map((u) => u._id);

    const before = await User.find({ company: companyId, teamLead: tl._id }).select("_id").lean();
    await User.updateMany({ company: companyId, teamLead: tl._id, _id: { $nin: validIds } }, { $set: { teamLead: null } });
    if (validIds.length) await User.updateMany({ company: companyId, _id: { $in: validIds } }, { $set: { teamLead: tl._id } });

    notifyTeamChanged(companyId, [tl._id, ...before.map((b) => b._id), ...validIds]);
    return res.json({ success: true, message: `${tl.name}'s team updated (${validIds.length} member(s)).`, memberIds: validIds });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// TEAM LEAD
// ═════════════════════════════════════════════════════════════════════════════

/** Middleware: caller must be an employee flagged as Team Lead, module on. */
async function requireTeamLead(req, res, next) {
  try {
    if (!(await teamScope.isTeamLeadReq(req))) {
      return res.status(403).json({ code: "NOT_TEAM_LEAD", message: "Only Team Leads can access this." });
    }
    const companyId = employeeCompanyId(req);
    const cust = await custSvc.getCustomization(companyId);
    if (!custSvc.isModuleOn(cust, "teamLeads")) {
      return res.status(403).json({ code: "MODULE_DISABLED", message: "Team Leads are switched off for this company." });
    }
    req.teamCtx = { companyId, tlId: String(req.user._id || req.user.userId), cust };
    return next();
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

function tlCan(req, perm) {
  return custSvc.permission(req.teamCtx.cust, "teamLead", perm);
}

const me = async (req, res) => {
  try {
    const id = req.user?._id || req.user?.userId;
    const info = await teamScope.getTeamInfo(id);
    let members = [];
    if (info.isTL) {
      members = await User.find({ company: employeeCompanyId(req), teamLead: id })
        .select("name email lastLoginAt").sort({ name: 1 }).lean();
    }
    let teamLead = null;
    if (info.teamLead) teamLead = await User.findById(info.teamLead).select("name email").lean();
    return res.json({ success: true, isTeamLead: info.isTL, teamLead, members });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

function parseRange(q, cust) {
  let from = q.from ? new Date(q.from) : custSvc.companyDayStart(cust);
  let to = q.to ? new Date(q.to) : new Date();
  if (Number.isNaN(from.getTime())) from = custSvc.companyDayStart(cust);
  if (Number.isNaN(to.getTime())) to = new Date();
  return { from, to };
}

const dashboard = async (req, res) => {
  try {
    const { companyId, tlId, cust } = req.teamCtx;
    const company = oid(companyId);
    const scopeIds = await teamScope.getTeamScopeObjectIds(companyId, tlId);
    const { from, to } = parseRange(req.query, cust);
    const now = new Date();
    const dayStart = custSvc.companyDayStart(cust);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const wonKeys = custSvc.statusKeysByCategory(cust, "won");
    const closedKeys = custSvc.closedStatusKeys(cust);
    const openMatch = { company, user: { $in: scopeIds }, mergedInto: null, isClosed: { $ne: true } };

    const [users, assigned, created, won, dueToday, overdue, untouched, calls, attendance] = await Promise.all([
      User.find({ _id: { $in: scopeIds } }).select("name email lastLoginAt isTeamLead").lean(),
      Lead.aggregate([{ $match: openMatch }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
      Lead.aggregate([{ $match: { ...openMatch, createdAt: { $gte: from, $lte: to } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
      Lead.aggregate([{ $match: { ...openMatch, status: { $in: wonKeys }, updatedAt: { $gte: from, $lte: to } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
      Lead.aggregate([{ $match: { ...openMatch, status: { $nin: closedKeys }, followUpDate: { $gte: dayStart, $lt: dayEnd } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
      Lead.aggregate([{ $match: { ...openMatch, status: { $nin: closedKeys }, followUpDate: { $lt: dayStart } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
      Lead.aggregate([{ $match: { ...openMatch, status: { $nin: closedKeys }, "callHistory.0": { $exists: false } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
      Lead.aggregate([
        { $match: { company, "callHistory.calledAt": { $gte: from, $lte: to } } },
        { $unwind: "$callHistory" },
        { $match: { "callHistory.userId": { $in: scopeIds }, "callHistory.calledAt": { $gte: from, $lte: to } } },
        { $group: { _id: "$callHistory.userId", n: { $sum: 1 } } },
      ]),
      Attendance.find({ company, user: { $in: scopeIds }, date: todayIST() })
        .select("user loginTime logoutTime status crmStatus").lean(),
    ]);

    const m = (rows) => new Map(rows.map((r) => [String(r._id), r.n]));
    const A = m(assigned), C = m(created), W = m(won), D = m(dueToday), O = m(overdue), U = m(untouched), K = m(calls);
    const att = new Map(attendance.map((a) => [String(a.user), a]));

    const members = users
      .map((u) => {
        const id = String(u._id);
        const a = att.get(id);
        return {
          _id: u._id, name: u.name, email: u.email, isTeamLead: !!u.isTeamLead, isMe: id === tlId,
          lastLoginAt: u.lastLoginAt,
          assignedOpen: A.get(id) || 0,
          newInRange: C.get(id) || 0,
          callsInRange: K.get(id) || 0,
          convertedInRange: W.get(id) || 0,
          followUpsToday: D.get(id) || 0,
          overdueFollowUps: O.get(id) || 0,
          untouched: U.get(id) || 0,
          attendance: a ? {
            clockedIn: !!a.loginTime, loginTime: a.loginTime, logoutTime: a.logoutTime,
            status: a.crmStatus || a.status || null,
          } : { clockedIn: false },
        };
      })
      .sort((x, y) => (y.isMe - x.isMe) || x.name.localeCompare(y.name));

    const sum = (k) => members.reduce((s, r) => s + (r[k] || 0), 0);
    return res.json({
      success: true,
      range: { from, to },
      totals: {
        members: members.filter((r) => !r.isMe).length,
        clockedIn: members.filter((r) => !r.isMe && r.attendance.clockedIn).length,
        assignedOpen: sum("assignedOpen"), newInRange: sum("newInRange"), callsInRange: sum("callsInRange"),
        convertedInRange: sum("convertedInRange"), followUpsToday: sum("followUpsToday"),
        overdueFollowUps: sum("overdueFollowUps"), untouched: sum("untouched"),
      },
      members,
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const TEAM_LEAD_PROJECTION = {
  name: 1, mobile: 1, primaryPhone: 1, secondaryPhone: 1, email: 1, status: 1, outcome: 1,
  temperature: 1, source: 1, campaign: 1, remark: 1, followUpDate: 1, user: 1, createdAt: 1,
  updatedAt: 1, isClosed: 1, mergedInto: 1, customFields: 1,
  callHistory: { $slice: -1 },
};

const teamLeads = async (req, res) => {
  try {
    const { companyId, tlId, cust } = req.teamCtx;
    if (!tlCan(req, "canViewTeamLeads")) return res.status(403).json({ message: "Viewing team leads is turned off for your company." });
    const scopeIds = await teamScope.getTeamScopeObjectIds(companyId, tlId);
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));

    const q = { company: oid(companyId), mergedInto: null, isClosed: { $ne: true }, user: { $in: scopeIds } };
    if (isId(req.query.member)) {
      if (!scopeIds.some((i) => String(i) === String(req.query.member))) return res.status(403).json({ message: "Not in your team." });
      q.user = oid(req.query.member);
    }
    if (req.query.status) q.status = String(req.query.status);
    const view = String(req.query.view || "");
    const closedKeys = custSvc.closedStatusKeys(cust);
    const dayStart = custSvc.companyDayStart(cust);
    if (view === "untouched") { q["callHistory.0"] = { $exists: false }; q.status = { $nin: closedKeys }; }
    if (view === "overdue")   { q.followUpDate = { $lt: dayStart }; q.status = { $nin: closedKeys }; }
    if (view === "today")     { q.followUpDate = { $gte: dayStart, $lt: new Date(dayStart.getTime() + 86400000) }; }
    if (req.query.search) {
      const re = new RegExp(escRe(String(req.query.search).trim().slice(0, 60)), "i");
      q.$or = [{ name: re }, { email: re }, { mobile: re }, { campaign: re }];
    }

    const [total, rows] = await Promise.all([
      Lead.countDocuments(q),
      Lead.find(q).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit)
        .select(TEAM_LEAD_PROJECTION).populate("user", "name email").lean(),
    ]);
    const reveal = tlCan(req, "canRevealTeamContact");
    const leads = rows.map((l) => maskLeadPII(l, reveal ? "admin" : "user", tlId));
    return res.json({ success: true, leads, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const reassign = async (req, res) => {
  try {
    const { companyId, tlId } = req.teamCtx;
    if (!tlCan(req, "canReassignLeads")) return res.status(403).json({ message: "Reassigning leads is turned off for Team Leads." });
    const { leadIds, toUserId, reason } = req.body || {};
    const ids = (Array.isArray(leadIds) ? leadIds : [leadIds]).filter(isId).slice(0, 500);
    if (!ids.length) return res.status(400).json({ message: "Select at least one lead." });
    if (!isId(toUserId) || !(await teamScope.isInTeam(companyId, tlId, toUserId))) {
      return res.status(403).json({ message: "You can only assign leads to members of your own team." });
    }
    const scopeIds = await teamScope.getTeamScopeObjectIds(companyId, tlId);
    const leads = await Lead.find({ _id: { $in: ids }, company: companyId, user: { $in: scopeIds } })
      .select("_id name user").lean();
    if (leads.length !== ids.length) {
      return res.status(403).json({ message: "Some selected leads don't belong to your team." });
    }
    const target = await User.findById(toUserId).select("name").lean();
    const moving = leads.filter((l) => String(l.user) !== String(toUserId));
    if (!moving.length) return res.json({ success: true, moved: 0, message: "Already assigned to that member." });

    const note = `Reassigned by Team Lead ${req.user.name || ""} to ${target?.name || "member"}${reason ? ` — ${String(reason).trim().slice(0, 300)}` : ""}`;
    await Lead.updateMany(
      { _id: { $in: moving.map((l) => l._id) } },
      {
        $set: { user: oid(toUserId), noActionAlert1hSentAt: null, noActionAlert2hSentAt: null },
        $push: { activityTimeline: { action: "reassigned", performedBy: oid(tlId), role: "team_lead", timestamp: new Date(), note } },
      }
    );

    emit(`agent:${toUserId}`, "new_lead_assigned", {
      leadId: String(moving[0]._id), leadName: moving[0].name, count: moving.length, eventType: "reassigned",
    });
    try {
      const { sendReassignedLeadNotification } = require("../services/fcmService");
      if (typeof sendReassignedLeadNotification === "function") {
        sendReassignedLeadNotification(String(toUserId), moving[0]).catch(() => {});
      }
    } catch { /* push is best-effort */ }
    for (const prev of new Set(moving.map((l) => String(l.user)))) {
      emit(`agent:${prev}`, "lead_reassigned_away", { count: moving.filter((l) => String(l.user) === prev).length });
    }

    return res.json({ success: true, moved: moving.length, message: `${moving.length} lead(s) moved to ${target?.name || "member"}.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const attendance = async (req, res) => {
  try {
    const { companyId, tlId } = req.teamCtx;
    if (!tlCan(req, "canViewTeamAttendance")) return res.status(403).json({ message: "Team attendance is turned off for Team Leads." });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : todayIST();
    const memberIds = await teamScope.getTeamMemberIds(companyId, tlId);
    const users = await User.find({ _id: { $in: memberIds } }).select("name email").sort({ name: 1 }).lean();
    const recs = await Attendance.find({ company: companyId, user: { $in: memberIds }, date })
      .select("user loginTime logoutTime status crmStatus breaks remarks").lean();
    const byUser = new Map(recs.map((r) => [String(r.user), r]));
    const rows = users.map((u) => {
      const r = byUser.get(String(u._id));
      return {
        _id: u._id, name: u.name, email: u.email,
        clockedIn: !!r?.loginTime, loginTime: r?.loginTime || null, logoutTime: r?.logoutTime || null,
        liveStatus: r?.status || null, attendanceStatus: r?.crmStatus || (r?.loginTime ? "present" : "absent"),
        breaks: Array.isArray(r?.breaks) ? r.breaks.length : 0, remarks: r?.remarks || "",
      };
    });
    return res.json({ success: true, date, rows });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const calls = async (req, res) => {
  try {
    const { companyId, tlId, cust } = req.teamCtx;
    if (!tlCan(req, "canViewTeamCalls")) return res.status(403).json({ message: "Team call logs are turned off for Team Leads." });
    const scopeIds = await teamScope.getTeamScopeObjectIds(companyId, tlId);
    const { from, to } = parseRange(req.query, cust);
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
    const q = { company: oid(companyId), user: { $in: scopeIds }, timestamp: { $gte: from, $lte: to } };
    if (isId(req.query.member)) {
      if (!scopeIds.some((i) => String(i) === String(req.query.member))) return res.status(403).json({ message: "Not in your team." });
      q.user = oid(req.query.member);
    }
    const [total, rows] = await Promise.all([
      MobileCallLog.countDocuments(q),
      MobileCallLog.find(q).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit)
        .select("user phoneNumber name callType duration timestamp matchedLead recordings.url recordings.durationSec")
        .populate("user", "name").lean(),
    ]);
    const reveal = tlCan(req, "canRevealTeamContact");
    const mask = (p) => {
      const s = String(p || "");
      return reveal || s.length < 6 ? s : `${s.slice(0, Math.max(2, s.length - 5))}XXXXX`;
    };
    const out = rows.map((r) => ({
      ...r,
      phoneNumber: String(r.user?._id || r.user) === tlId ? r.phoneNumber : mask(r.phoneNumber),
    }));
    return res.json({ success: true, calls: out, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── Team Lead calls a team member's lead ────────────────────────────────────
// Returns the real number (lists stay masked) so the Team Lead can dial it,
// and records the action on the lead's timeline.
async function findTeamLead(req, leadId) {
  const { companyId, tlId } = req.teamCtx;
  if (!isId(leadId)) return null;
  const scopeIds = await teamScope.getTeamScopeObjectIds(companyId, tlId);
  return Lead.findOne({ _id: leadId, company: companyId, user: { $in: scopeIds }, mergedInto: null });
}

const callLead = async (req, res) => {
  try {
    if (!tlCan(req, "canCallTeamLeads")) return res.status(403).json({ message: "Calling team leads is turned off for Team Leads." });
    const lead = await findTeamLead(req, req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found in your team." });
    const phone = lead.primaryPhone || lead.mobile || "";
    if (!phone) return res.status(400).json({ message: "This lead has no phone number." });
    await Lead.updateOne({ _id: lead._id }, {
      $push: { activityTimeline: {
        action: "team_lead_call", performedBy: oid(req.teamCtx.tlId), role: "team_lead",
        timestamp: new Date(), note: `Call started by Team Lead ${req.user.name || ""}`.trim(),
      } },
    });
    return res.json({ success: true, leadId: lead._id, name: lead.name, phone, secondaryPhone: lead.secondaryPhone || "" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// ── Team Lead logs the result of that call ──────────────────────────────────
const logCall = async (req, res) => {
  try {
    const { cust, tlId } = req.teamCtx;
    if (!tlCan(req, "canEditTeamLeads")) return res.status(403).json({ message: "Updating team leads is turned off for Team Leads." });
    const lead = await findTeamLead(req, req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found in your team." });

    const lu = cust.workflows.leadUpdate || {};
    const remark = String(req.body?.remark || "").trim().slice(0, 2000);
    if (lu.remarkRequired && !remark) return res.status(400).json({ message: "A remark is required when logging a call." });
    const oc = req.body?.outcome ? custSvc.findOutcome(cust, req.body.outcome) : null;
    const outcomeKey = oc?.key || lu.defaultOutcomeWhenMissing || "Call Back";

    const set = { outcome: outcomeKey };
    if (remark) set.remark = remark;
    if (req.body?.followUpDate) {
      const d = new Date(req.body.followUpDate);
      if (!Number.isNaN(d.getTime())) set.followUpDate = d;
    }
    await Lead.updateOne({ _id: lead._id }, {
      $set: set,
      $push: {
        callHistory: { userId: oid(tlId), userName: req.user.name || "", remark, outcome: outcomeKey, calledAt: new Date() },
        activityTimeline: { action: "call_logged", performedBy: oid(tlId), role: "team_lead", timestamp: new Date(), note: `${oc?.label || outcomeKey}${remark ? ` — ${remark.slice(0, 200)}` : ""}` },
      },
    });
    emit(`agent:${lead.user}`, "lead_updated", { leadId: String(lead._id), by: "team_lead" });
    return res.json({ success: true, message: "Call logged." });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  // admin
  adminOverview, adminSetRole, adminSetTeamLead, adminSetMembers,
  // team lead
  requireTeamLead, me, dashboard, teamLeads, reassign, attendance, calls, callLead, logCall,
};
