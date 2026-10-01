// utils/teamScope.js
// ─────────────────────────────────────────────────────────────────────────────
// Team Lead hierarchy helpers.
//
//   Admin → Team Lead (User.isTeamLead) → Employees (User.teamLead = TL id)
//
// A Team Lead is a regular employee account, so every existing employee
// feature keeps working. These helpers answer "who is in my team" and
// "may this Team Lead touch that lead / user" — always scoped to a company.
// Membership is cached in-process for a short time; any change made through
// the team-management endpoints calls invalidateTeam().
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const User = require("../models/Users");

const CACHE_MS = 30 * 1000;
const _members = new Map(); // `${companyId}:${tlId}` → { ids:Set<string>, exp }
const _tlFlag  = new Map(); // userId → { isTL, teamLead, company, exp }

const sid = (v) => (v == null ? "" : String(v._id || v));

function invalidateTeam(companyId) {
  const prefix = `${sid(companyId)}:`;
  for (const k of _members.keys()) if (k.startsWith(prefix)) _members.delete(k);
  _tlFlag.clear();
}

/** Fresh (cached 30s) team-lead info for a user id. */
async function getTeamInfo(userId) {
  const id = sid(userId);
  if (!id || !mongoose.isValidObjectId(id)) return { isTL: false, teamLead: null, company: null };
  const hit = _tlFlag.get(id);
  if (hit && hit.exp > Date.now()) return hit;
  const u = await User.findById(id).select("isTeamLead teamLead company").lean();
  const info = {
    isTL: !!u?.isTeamLead,
    teamLead: u?.teamLead ? String(u.teamLead) : null,
    company: u?.company ? String(u.company) : null,
    exp: Date.now() + CACHE_MS,
  };
  _tlFlag.set(id, info);
  return info;
}

/** Is the authenticated employee request from a Team Lead? */
async function isTeamLeadReq(req) {
  const role = req.user?.role;
  if (role && role !== "user" && role !== "employee") return false;
  const id = req.user?._id || req.user?.userId;
  if (!id) return false;
  return (await getTeamInfo(id)).isTL;
}

/** Member ids (strings) of a Team Lead — NOT including the Team Lead. */
async function getTeamMemberIds(companyId, teamLeadId) {
  const key = `${sid(companyId)}:${sid(teamLeadId)}`;
  const hit = _members.get(key);
  if (hit && hit.exp > Date.now()) return [...hit.ids];
  const rows = await User.find({ company: sid(companyId), teamLead: sid(teamLeadId) }).select("_id").lean();
  const ids = new Set(rows.map((r) => String(r._id)));
  _members.set(key, { ids, exp: Date.now() + CACHE_MS });
  return [...ids];
}

/** Team Lead + members, as ObjectIds (for Mongo $in queries). */
async function getTeamScopeObjectIds(companyId, teamLeadId) {
  const ids = [sid(teamLeadId), ...(await getTeamMemberIds(companyId, teamLeadId))];
  return ids.filter(mongoose.isValidObjectId).map((i) => new mongoose.Types.ObjectId(i));
}

/** Is `userId` the Team Lead or one of their members? */
async function isInTeam(companyId, teamLeadId, userId) {
  const u = sid(userId);
  if (!u) return false;
  if (u === sid(teamLeadId)) return true;
  return (await getTeamMemberIds(companyId, teamLeadId)).includes(u);
}

/** Team Lead id of an employee (or null). */
async function getTeamLeadOf(userId) {
  const info = await getTeamInfo(userId);
  return info.teamLead;
}

module.exports = {
  invalidateTeam,
  getTeamInfo,
  isTeamLeadReq,
  getTeamMemberIds,
  getTeamScopeObjectIds,
  isInTeam,
  getTeamLeadOf,
};
