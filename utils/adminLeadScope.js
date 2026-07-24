// utils/adminLeadScope.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-admin lead visibility.
//
// Within ONE company there can be many admins plus a single super_admin.
// Requirement: an admin must ONLY see the leads that belong to them; leads that
// belong to another admin must be invisible. The super_admin sees everything in
// the company.
//
// Ownership model (matches the existing convention in leadController.js where a
// lead's owning admin is resolved as `lead.assignedAdmin || employee.createdBy`):
//   A lead belongs to admin X when EITHER
//     • lead.assignedAdmin === X, OR
//     • lead.user is an employee whose `createdBy` === X.
//
// NOTE: no optional chaining / nullish coalescing is used here on purpose
// (backend formatter constraint).
// ─────────────────────────────────────────────────────────────────────────────
const User = require("../models/Users");

function resolveRole(req) {
  if (req.admin && req.admin.role) return req.admin.role;
  if (req.user && req.user.role) return req.user.role;
  return null;
}

function resolveAdminId(req) {
  if (req.admin && req.admin._id) return req.admin._id;
  if (req.user && req.user._id) return req.user._id;
  if (req.user && req.user.id) return req.user.id;
  return null;
}

function isSuperAdminRole(role) {
  return role === "super_admin" || role === "superadmin";
}

// Returns a Mongo filter FRAGMENT scoping leads to the calling admin.
//   • admin        -> { $or: [ ... ] }  (own assigned + own employees' leads)
//   • super_admin  -> {}                (no restriction — whole company)
//   • employee/other -> {}              (unchanged — employee routes scope by
//                                         `user` themselves; never restrict here)
// Callers should combine it with their base query via mergeLeadScope() so that
// an existing `$or` in the base query is never clobbered.
async function getAdminLeadScope(req, companyId) {
  const role = resolveRole(req);

  // ONLY a plain "admin" is restricted. super_admin sees everything; employees
  // and any other role are left untouched so shared handlers keep working.
  if (role !== "admin") return {};

  const adminId = resolveAdminId(req);
  if (!adminId) return {};

  // Employees this admin created — their leads count as this admin's leads.
  const employees = await User.find({ company: companyId, createdBy: adminId })
    .select("_id")
    .lean();
  const employeeIds = employees.map(function (u) { return u._id; });

  const or = [{ assignedAdmin: adminId }];
  if (employeeIds.length > 0) or.push({ user: { $in: employeeIds } });

  return { $or: or };
}

// Safely merge a scope fragment into a base filter.
// If the scope is empty (super_admin) the base is returned unchanged.
// Otherwise base + scope are AND-ed so neither side's `$or` is overwritten.
function mergeLeadScope(baseFilter, scope) {
  if (!scope || Object.keys(scope).length === 0) return baseFilter;
  return { $and: [baseFilter, scope] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-admin CAMPAIGN-CONFIG visibility (Meta / Google / Website configs).
//
// A campaign "belongs" to the admin who connected it (config.createdBy).
//   • admin        -> own configs + unclaimed (createdBy null = legacy/pre-ownership)
//   • super_admin  -> all configs
//   • employee/other -> unchanged
//
// Use $or so legacy configs (createdBy null) are accessible to ALL admins
// until a backfill assigns proper ownership. Once createdBy is set on a config
// it becomes exclusive to that admin.
// ─────────────────────────────────────────────────────────────────────────────
function getAdminConfigScope(req) {
  const role = resolveRole(req);
  if (role !== "admin") return {};
  const adminId = resolveAdminId(req);
  if (!adminId) return {};
  // Show: (a) own configs, (b) legacy configs with no owner yet
  return { $or: [{ createdBy: adminId }, { createdBy: null }, { createdBy: { $exists: false } }] };
}

module.exports = { getAdminLeadScope, mergeLeadScope, isSuperAdminRole, getAdminConfigScope, resolveAdminId };
