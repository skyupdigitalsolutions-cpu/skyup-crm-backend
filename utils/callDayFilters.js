// utils/callDayFilters.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Lead filters for the mobile "Calls by Day" screen:
//
//   • assigned=day         → only leads NEWLY ASSIGNED on the selected day
//   • campaign / adsetId / adId → ad-level filter (campaign → ad set → ad)
//
// "Newly assigned on day D" — there is no single "assigned at" field on a lead, so it is built
// from what the system does record. A lead counts as newly assigned on D when EITHER
//   1. it was created on D (a new lead is assigned to its employee when it arrives, so its
//      creation time is its assignment time — this is also what the screen's "Assigned today"
//      label has always used), OR
//   2. its activity log has an "assigned" / "reassigned" entry on D (pool assignment by an
//      admin, team-lead / admin re-assignment).
//
// Ad-level data exists only for leads that arrived with it: a Meta lead form saves the ad set id
// and ad id (and ad name); Google saves the ad group. Leads without it are reachable through the
// "No ad recorded" choice (NONE). Everything here is plain exact-match on stored values — never a
// regex built from user input.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const ASSIGN_ACTIONS = ["assigned", "reassigned"];
const NONE = "__none__";                      // "this lead has no campaign / ad set / ad recorded"
const DAY_MS = 24 * 60 * 60 * 1000;

// Query values arrive as strings, but an attacker can send ?campaign[$ne]=x (an object) — only plain strings pass.
const clean = (v) => (typeof v === "string" ? v.trim().slice(0, 160) : "");

function parseLeadFilters(query) {
  const q = query || {};
  const a = typeof q.assigned === "string" ? q.assigned.toLowerCase() : "";
  return { assigned: a === "day" || a === "1" || a === "true", campaign: clean(q.campaign), adsetId: clean(q.adsetId), adId: clean(q.adId) };
}
const hasLeadFilters = (f) => !!(f && (f.assigned || f.campaign || f.adsetId || f.adId));

// Local-day bounds from ?date=YYYY-MM-DD and ?tzOffset (device UTC offset in minutes, IST = 330) — the same
// convention the other call-log endpoints use. dayEnd is the last millisecond of the day.
function dayBounds(date, tzOffset, now = Date.now()) {
  const off = parseInt(tzOffset || "0", 10) || 0;
  let dayStart;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    const [y, m, d] = String(date).split("-").map(Number);
    dayStart = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
    dayStart.setUTCMinutes(dayStart.getUTCMinutes() - off);
  } else {
    dayStart = new Date(Math.floor((now + off * 60000) / DAY_MS) * DAY_MS - off * 60000);
  }
  return { dayStart, dayEnd: new Date(dayStart.getTime() + DAY_MS - 1) };
}

// null / "" / missing all count as "nothing recorded"
const blank = (path) => ({ $or: [{ [path]: null }, { [path]: "" }] });

// MongoDB conditions (to be AND-ed) for the active filters.
function leadFilterConditions(f, dayStart, dayEnd) {
  const c = [];
  if (!f) return c;
  if (f.assigned) {
    c.push({ $or: [
      { createdAt: { $gte: dayStart, $lte: dayEnd } },
      { activityTimeline: { $elemMatch: { action: { $in: ASSIGN_ACTIONS }, timestamp: { $gte: dayStart, $lte: dayEnd } } } },
    ] });
  }
  if (f.campaign) c.push(f.campaign === NONE ? blank("campaign") : { campaign: f.campaign });
  if (f.adsetId) {
    c.push(f.adsetId === NONE
      ? { $and: [blank("attribution.metaAdsetId"), blank("attribution.googleAdGroupId")] }
      : { $or: [{ "attribution.metaAdsetId": f.adsetId }, { "attribution.googleAdGroupId": f.adsetId }] });
  }
  if (f.adId) c.push(f.adId === NONE ? blank("attribution.metaAdId") : { "attribution.metaAdId": f.adId });
  return c;
}

// The same rule as above, evaluated on one lead — used to flag each returned lead ("New today").
function wasAssignedOnDay(lead, dayStart, dayEnd) {
  const s = +dayStart, e = +dayEnd;
  const created = lead && lead.createdAt ? +new Date(lead.createdAt) : NaN;
  if (created >= s && created <= e) return true;
  return ((lead && lead.activityTimeline) || []).some((a) => {
    if (!a || ASSIGN_ACTIONS.indexOf(a.action) < 0) return false;
    const t = +new Date(a.timestamp);
    return t >= s && t <= e;
  });
}

// ── Options for the pickers: every campaign → ad set → ad in the screen's universe, with lead counts ──
// "first non-empty of two fields" as an aggregation expression
const firstFilled = (a, b) => ({ $cond: [{ $gt: [{ $strLenCP: { $ifNull: [a, ""] } }, 0] }, a, { $ifNull: [b, ""] }] });
const groupStage = () => ({ $group: {
  _id: {
    campaign: { $ifNull: ["$campaign", ""] },
    adsetId:  firstFilled("$attribution.metaAdsetId", "$attribution.googleAdGroupId"),
    adsetName: { $ifNull: ["$adSetName", ""] },
    adId:     { $ifNull: ["$attribution.metaAdId", ""] },
    adName:   { $ifNull: ["$attribution.metaAdName", ""] },
  },
  count: { $sum: 1 },
} });

const tail = (id) => String(id).slice(-6);
// groups: [{ _id: {campaign, adsetId, adsetName, adId, adName}, count }, …] (rows from several queries may repeat a key)
function buildFilterTree(groups) {
  const camps = new Map();
  let total = 0;
  for (const g of groups || []) {
    const k = g._id || {}, n = Number(g.count) || 0;
    total += n;
    const cKey = k.campaign || NONE, sKey = k.adsetId || NONE, aKey = k.adId || NONE;
    if (!camps.has(cKey)) camps.set(cKey, { value: cKey, label: k.campaign || "No campaign", count: 0, sets: new Map() });
    const c = camps.get(cKey); c.count += n;
    if (!c.sets.has(sKey)) c.sets.set(sKey, { value: sKey, label: "", count: 0, ads: new Map() });
    const s = c.sets.get(sKey); s.count += n;
    if (!s.label || (k.adsetName && s.label.indexOf("Ad set …") === 0)) s.label = k.adsetName || (k.adsetId ? `Ad set …${tail(k.adsetId)}` : "No ad set recorded");
    if (!s.ads.has(aKey)) s.ads.set(aKey, { value: aKey, label: "", count: 0 });
    const a = s.ads.get(aKey); a.count += n;
    if (!a.label || (k.adName && a.label.indexOf("Ad …") === 0)) a.label = k.adName || (k.adId ? `Ad …${tail(k.adId)}` : "No ad recorded");
  }
  const byCount = (x, y) => y.count - x.count || String(x.label).localeCompare(String(y.label));
  const campaigns = [...camps.values()].map((c) => ({
    value: c.value, label: c.label, count: c.count,
    adSets: [...c.sets.values()].map((s) => ({ value: s.value, label: s.label, count: s.count, ads: [...s.ads.values()].sort(byCount) })).sort(byCount),
  })).sort(byCount);
  return { total, campaigns };
}

module.exports = { ASSIGN_ACTIONS, NONE, parseLeadFilters, hasLeadFilters, dayBounds, leadFilterConditions, wasAssignedOnDay, groupStage, buildFilterTree };
