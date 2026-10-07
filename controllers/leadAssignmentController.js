// controllers/leadAssignmentController.js
// ─────────────────────────────────────────────────────────────────────────────
// Lead assignment: company default (round robin / manual), the shared admin
// pool for manually-assigned imports, and admin groups.
//
//   GET    /api/lead/assignment/options          admin + super admin
//   PUT    /api/lead/assignment/settings         super admin
//   POST   /api/lead/assignment/claim            admin + super admin
//   GET    /api/lead/assignment/groups           super admin
//   POST   /api/lead/assignment/groups           super admin
//   PUT    /api/lead/assignment/groups/:groupId  super admin
//   DELETE /api/lead/assignment/groups/:groupId  super admin
//
// All routes sit behind protectAdmin, which accepts both admin and super_admin
// tokens and sets req.admin (role "admin" | "super_admin").
// ─────────────────────────────────────────────────────────────────────────────
const mongoose   = require("mongoose");
const Lead       = require("../models/Leads");
const Admin      = require("../models/Admin");
const User       = require("../models/Users");
const AdminGroup = require("../models/AdminGroup");
const custSvc    = require("../services/customizationService");
const { getAdminReach, clearAdminLeadScopeCache, getAdminLeadScope, mergeLeadScope } = require("../utils/adminLeadScope");

const isSuper = (req) => ["super_admin", "superadmin"].includes(req.admin?.role) || !!req.superAdmin;
const companyOf = (req) =>
  req.admin?.company?._id || req.admin?.company || req.superAdmin?.company?._id || req.superAdmin?.company || null;
const oid = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const IMPORT_MODES = ["round_robin", "least_loaded", "unassigned", "manual"];

// Admins (role "admin") of the company — the people a pool can be offered to.
async function companyAdmins(companyId) {
  return Admin.find({ company: companyId, role: "admin" }).select("_id name email").sort({ name: 1 }).lean();
}

// ── GET /assignment/options ─────────────────────────────────────────────────
// Everything the import window and the "Unassigned" list need:
//   importStrategy  company default
//   admins          admins this caller may offer a pool to
//   groups          groups (for quick-select)
//   employees       employees this caller may assign pool leads to
const getAssignmentOptions = async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(400).json({ message: "Company not found for this account." });
    const cust = await custSvc.getCustomization(companyId);
    const importStrategy = cust?.workflows?.assignment?.importStrategy || "round_robin";
    const whatsappAutoLead = cust?.workflows?.assignment?.whatsappAutoLead === true;

    let admins, groups, employees;
    if (isSuper(req)) {
      admins    = await companyAdmins(companyId);
      groups    = await AdminGroup.find({ company: companyId }).select("_id name admins").sort({ name: 1 }).lean();
      employees = await User.find({ company: companyId, isActive: { $ne: false } }).select("_id name email createdBy").sort({ name: 1 }).lean();
    } else {
      const reach = await getAdminReach(companyId, req.admin._id);
      admins    = await Admin.find({ _id: { $in: reach.adminIds }, company: companyId }).select("_id name email").sort({ name: 1 }).lean();
      groups    = await AdminGroup.find({ company: companyId, admins: req.admin._id }).select("_id name admins").sort({ name: 1 }).lean();
      employees = await User.find({ _id: { $in: reach.employeeIds }, isActive: { $ne: false } }).select("_id name email createdBy").sort({ name: 1 }).lean();
    }

    res.json({ importStrategy, whatsappAutoLead, admins, groups, employees, isSuperAdmin: isSuper(req) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /assignment/settings  { importStrategy } ─────────────────────────────
const updateAssignmentSettings = async (req, res) => {
  try {
    if (!isSuper(req)) return res.status(403).json({ message: "Only a super admin can change this setting." });
    const companyId = companyOf(req);
    // Either setting may be sent on its own.
    const patch = {};
    if (req.body?.importStrategy !== undefined) {
      const mode = String(req.body.importStrategy || "");
      if (!IMPORT_MODES.includes(mode)) {
        return res.status(400).json({ message: "Choose round_robin, least_loaded, unassigned or manual." });
      }
      patch.importStrategy = mode;
    }
    if (req.body?.whatsappAutoLead !== undefined) {
      if (typeof req.body.whatsappAutoLead !== "boolean") {
        return res.status(400).json({ message: "whatsappAutoLead must be true or false." });
      }
      patch.whatsappAutoLead = req.body.whatsappAutoLead;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ message: "Nothing to update." });
    const cust = await custSvc.getCustomizationFresh(companyId);
    const workflows = JSON.parse(JSON.stringify(cust.workflows || {}));
    workflows.assignment = { ...(workflows.assignment || {}), ...patch };
    const updated = await custSvc.updateSection(companyId, "workflows", workflows, {
      id: req.admin?._id, name: req.admin?.name, role: "super_admin",
    });
    const a = updated?.workflows?.assignment || {};
    res.json({ success: true, importStrategy: a.importStrategy, whatsappAutoLead: a.whatsappAutoLead === true });
  } catch (err) {
    res.status(err?.name === "CustomizationError" ? 400 : 500).json({ message: err.message });
  }
};

// ── POST /assignment/claim  { leadIds: [], userId } ─────────────────────────
// Assigns unassigned pool leads to an employee. Atomic: only leads that are
// still unassigned are taken, so two admins can't both claim the same lead.
const claimPoolLeads = async (req, res) => {
  try {
    const companyId = companyOf(req);
    const leadIds = Array.isArray(req.body?.leadIds) ? req.body.leadIds.filter(oid) : [];
    const userId  = req.body?.userId;
    if (!leadIds.length) return res.status(400).json({ message: "Select at least one lead." });
    if (leadIds.length > 1000) return res.status(400).json({ message: "Assign at most 1,000 leads at a time." });
    if (!oid(userId)) return res.status(400).json({ message: "Choose an employee." });

    const employee = await User.findOne({ _id: userId, company: companyId }).select("_id name createdBy").lean();
    if (!employee) return res.status(400).json({ message: "Choose an employee from your company." });

    const filter = { _id: { $in: leadIds }, company: companyId, user: null };
    if (!isSuper(req)) {
      const reach = await getAdminReach(companyId, req.admin._id);
      if (!reach.employeeIds.some((e) => String(e) === String(employee._id))) {
        return res.status(403).json({ message: "You can only assign to employees in your team or admin group." });
      }
      // Only pool leads offered to this admin's group, or unassigned leads the group already owns.
      filter.$or = [
        { poolAdmins: { $in: reach.adminIds } },
        { assignedAdmin: { $in: reach.adminIds } },
      ];
    }

    const now = new Date();
    const update = {
      $set: {
        user: employee._id,
        assignedAdmin: employee.createdBy || req.admin?._id || null,
        poolAdmins: [],
        noActionAlert1hSentAt: null,
        noActionAlert2hSentAt: null,
      },
      $push: {
        activityTimeline: {
          action: "assigned",
          performedBy: req.admin?._id || null,
          role: isSuper(req) ? "superadmin" : "admin",
          timestamp: now,
          note: `Assigned to ${employee.name} from the unassigned pool`,
        },
      },
    };

    // One atomic "assign only if still unassigned" per lead. If two admins
    // claim the same lead at the same moment, exactly one of them gets it.
    // (A single updateMany is not reliably exclusive on every MongoDB-
    // compatible backend; per-document findOneAndUpdate is.)
    const { _id: _ids, ...rest } = filter;
    let claimed = 0;
    const ids = [...new Set(leadIds.map(String))];
    for (let i = 0; i < ids.length; i += 25) {
      const batch = ids.slice(i, i + 25);
      const results = await Promise.all(batch.map((id) =>
        Lead.findOneAndUpdate({ ...rest, _id: id }, update, { new: false }).lean()
      ));
      claimed += results.filter(Boolean).length;
    }
    const skipped = ids.length - claimed;

    const io = global._io;
    if (io && claimed > 0) {
      io.to(`agent:${employee._id}`).emit("new_lead_assigned", {
        count: claimed, eventType: "pool_assigned", source: "",
        leadName: claimed === 1 ? "1 lead" : `${claimed} leads`,
      });
    }

    res.json({
      success: true, claimed, skipped,
      message: skipped
        ? `${claimed} assigned to ${employee.name}. ${skipped} were already taken by someone else or aren't in your pool.`
        : `${claimed} assigned to ${employee.name}.`,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /assignment/unassigned ──────────────────────────────────────────────
// Leads with no employee that this caller may assign: for an admin, pool leads
// offered to them or their group plus their group's unassigned leads; for a
// super admin, every unassigned lead in the company. Newest first, max 1,000.
const listUnassigned = async (req, res) => {
  try {
    const companyId = companyOf(req);
    const scope = await getAdminLeadScope(req, companyId);
    const query = mergeLeadScope({ company: companyId, mergedInto: null, user: null }, scope);
    const [leads, total] = await Promise.all([
      Lead.find(query)
        .select("_id name mobile source status createdAt poolAdmins assignedAdmin")
        .populate("poolAdmins", "name")
        .sort({ createdAt: -1 })
        .limit(1000)
        .lean(),
      Lead.countDocuments(query),
    ]);
    const mask = (m) => {
      const d = String(m || "").replace(/\D/g, "");
      return d.length >= 4 ? `••••••${d.slice(-4)}` : "";
    };
    res.json({
      total,
      leads: leads.map((l) => ({
        _id: l._id,
        name: l.name || "Unknown",
        phone: mask(l.mobile),
        source: l.source || "",
        status: l.status || "",
        createdAt: l.createdAt,
        poolAdmins: (l.poolAdmins || []).map((a) => a?.name).filter(Boolean),
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Admin groups (super admin) ───────────────────────────────────────────────
async function cleanGroupInput(req, companyId) {
  const name = String(req.body?.name || "").trim().slice(0, 80);
  if (!name) return { error: "Enter a group name." };
  const ids = Array.isArray(req.body?.admins) ? [...new Set(req.body.admins.filter(oid).map(String))] : [];
  if (ids.length < 2) return { error: "A group needs at least two admins." };
  const found = await Admin.find({ _id: { $in: ids }, company: companyId, role: "admin" }).select("_id").lean();
  if (found.length !== ids.length) return { error: "Choose admins from your company." };
  return { name, admins: found.map((a) => a._id) };
}

const listGroups = async (req, res) => {
  try {
    if (!isSuper(req)) return res.status(403).json({ message: "Only a super admin can manage admin groups." });
    const companyId = companyOf(req);
    const [groups, admins] = await Promise.all([
      AdminGroup.find({ company: companyId }).populate("admins", "name email").sort({ name: 1 }).lean(),
      companyAdmins(companyId),
    ]);
    res.json({ groups, admins });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const createGroup = async (req, res) => {
  try {
    if (!isSuper(req)) return res.status(403).json({ message: "Only a super admin can manage admin groups." });
    const companyId = companyOf(req);
    const input = await cleanGroupInput(req, companyId);
    if (input.error) return res.status(400).json({ message: input.error });
    const group = await AdminGroup.create({ company: companyId, ...input, createdBy: req.admin?._id || null });
    clearAdminLeadScopeCache();
    res.status(201).json({ group: await AdminGroup.findById(group._id).populate("admins", "name email").lean() });
  } catch (err) {
    if (err?.code === 11000) return res.status(400).json({ message: "A group with this name already exists." });
    res.status(500).json({ message: err.message });
  }
};

const updateGroup = async (req, res) => {
  try {
    if (!isSuper(req)) return res.status(403).json({ message: "Only a super admin can manage admin groups." });
    const companyId = companyOf(req);
    if (!oid(req.params.groupId)) return res.status(400).json({ message: "Invalid group." });
    const input = await cleanGroupInput(req, companyId);
    if (input.error) return res.status(400).json({ message: input.error });
    const group = await AdminGroup.findOneAndUpdate(
      { _id: req.params.groupId, company: companyId }, { $set: input }, { new: true }
    ).populate("admins", "name email").lean();
    if (!group) return res.status(404).json({ message: "Group not found." });
    clearAdminLeadScopeCache();
    res.json({ group });
  } catch (err) {
    if (err?.code === 11000) return res.status(400).json({ message: "A group with this name already exists." });
    res.status(500).json({ message: err.message });
  }
};

const deleteGroup = async (req, res) => {
  try {
    if (!isSuper(req)) return res.status(403).json({ message: "Only a super admin can manage admin groups." });
    const companyId = companyOf(req);
    if (!oid(req.params.groupId)) return res.status(400).json({ message: "Invalid group." });
    const result = await AdminGroup.deleteOne({ _id: req.params.groupId, company: companyId });
    if (!result.deletedCount) return res.status(404).json({ message: "Group not found." });
    clearAdminLeadScopeCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── Helper for the import handler ────────────────────────────────────────────
// Validates the admins a manual import should be offered to.
// Returns { poolAdmins } or { error }.
async function resolvePoolAdmins(req, companyId, requested) {
  const ids = Array.isArray(requested) ? [...new Set(requested.filter(oid).map(String))] : [];
  if (isSuper(req)) {
    if (!ids.length) return { error: "Tick at least one admin for manual assignment." };
    const found = await Admin.find({ _id: { $in: ids }, company: companyId, role: "admin" }).select("_id").lean();
    if (found.length !== ids.length) return { error: "Choose admins from your company." };
    return { poolAdmins: found.map((a) => a._id) };
  }
  // A plain admin may offer the pool to themselves and their group mates.
  const reach = await getAdminReach(companyId, req.admin._id);
  const allowed = new Set(reach.adminIds.map(String));
  const chosen = ids.length ? ids : [String(req.admin._id)];
  if (!chosen.every((id) => allowed.has(id))) return { error: "You can only choose yourself or admins in your group." };
  return { poolAdmins: chosen.map((id) => new mongoose.Types.ObjectId(id)) };
}

module.exports = {
  getAssignmentOptions, updateAssignmentSettings, claimPoolLeads, listUnassigned,
  listGroups, createGroup, updateGroup, deleteGroup,
  resolvePoolAdmins, IMPORT_MODES,
};
