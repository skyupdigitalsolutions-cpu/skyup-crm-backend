// utils/adminLeadScope.js
// ─────────────────────────────────────────────────────────────────────────────
// Per-admin lead visibility.
//
// Within ONE company there can be many admins plus super_admins.
// An admin sees the leads that belong to them OR to any admin in the same
// AdminGroup (groups share leads), plus unassigned "pool" leads offered to them.
// Leads of admins outside their groups stay invisible. A super_admin sees
// everything in the company.
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

const _scopeCache = new Map(); // "company:admin" → { ids, exp }
function clearAdminLeadScopeCache() { _scopeCache.clear(); }

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
// Admin ids whose leads this admin may see: the admin plus every admin that
// shares an AdminGroup with them. Cached with the employee list below.
async function getGroupAdminIds(companyId, adminId) {
  const AdminGroup = require("../models/AdminGroup");
  const groups = await AdminGroup.find({ company: companyId, admins: adminId }).select("admins").lean();
  const ids = new Map();
  ids.set(String(adminId), adminId);
  groups.forEach(function (g) {
    (g.admins || []).forEach(function (a) { ids.set(String(a), a); });
  });
  return Array.from(ids.values());
}

// Cached { adminIds, employeeIds } for an admin (20s).
async function getAdminReach(companyId, adminId) {
  const key = String(companyId) + ":" + String(adminId);
  const hit = _scopeCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const adminIds = await getGroupAdminIds(companyId, adminId);
  const employees = await User.find({ company: companyId, createdBy: { $in: adminIds } })
    .select("_id")
    .lean();
  const value = { adminIds: adminIds, employeeIds: employees.map(function (u) { return u._id; }) };
  if (_scopeCache.size > 2000) _scopeCache.clear();
  _scopeCache.set(key, { value: value, exp: Date.now() + 20 * 1000 });
  return value;
}

async function getAdminLeadScope(req, companyId) {
  const role = resolveRole(req);
  // ONLY a plain "admin" is restricted. super_admin sees everything; employees
  // and any other role are left untouched so shared handlers keep working.
  if (role !== "admin") return {};
  const adminId = resolveAdminId(req);
  if (!adminId) return {};

  // Admin groups: admins in the same group share each other's leads, so the
  // ownership checks below run over every admin in the caller's groups.
  // PERF: cached 20s per admin (was a DB round trip on every lead request).
  const reach = await getAdminReach(companyId, adminId);

  const or = [{ assignedAdmin: { $in: reach.adminIds } }];
  if (reach.employeeIds.length > 0) or.push({ user: { $in: reach.employeeIds } });
  // Shared pool: unassigned leads offered to this admin (or a group mate).
  // `user: null` makes a pool lead drop out of everyone else's view the
  // moment one admin assigns it to an employee.
  or.push({ poolAdmins: { $in: reach.adminIds }, user: null });
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

module.exports = {
  clearAdminLeadScopeCache, getAdminLeadScope, mergeLeadScope, isSuperAdminRole, getAdminConfigScope, resolveAdminId,
  getAdminReach };
