// services/leadInsightsService.js
// ─────────────────────────────────────────────────────────────────────────────
// Backs Daily Report → Lead Insights.
//
// REUSES rather than duplicates:
//   • Lead.callHistory     — remarks + call outcomes (spec's "Call History" /
//                            "Remarks" sections — there is no separate Remark
//                            model, remarks live on callHistory entries)
//   • Lead.scheduledCalls  — follow-ups ("type: follow-up" | "verification")
//   • getISTDayBounds()    — same IST day-boundary helper every other report
//                            endpoint uses (reportService.js), so "today" here
//                            always agrees with the rest of the Daily Report
//   • mergeLeadScope()     — same per-admin lead visibility used everywhere
//   • categorise()/REASON_RULES from nonConversionService.js — the SAME
//     keyword-based non-conversion reason buckets used by the full
//     Non-Conversion Analysis report, so the two never disagree. This service
//     only runs the fast, non-AI pass (no Groq calls) — the full AI-powered
//     breakdown stays behind GET /reports/non-conversion, opened on demand
//     from the UI, per the "don't auto-generate AI on every page load" rule.
//
// Lead relevance to a given day (spec section 16 — do NOT only filter by
// creation date): a lead is "of the day" if ANY of the following happened on
// that IST day — created, had a call logged, has a follow-up due, or was
// closed (converted/not-converted). Each of those is tracked with its own
// date field so a lead created last week with a follow-up due today still
// shows up under Today's Follow-ups.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const Lead = require("../models/Leads");
const { mergeLeadScope } = require("../utils/adminLeadScope");
const { getISTDayBounds } = require("./reportService");
const { categorise, pickReasonText } = require("./nonConversionService");

const CONVERTED_RE = /^(converted|won|customer|closed won|closed-won|complete[d]?)$/i;
const isConverted = (status) => CONVERTED_RE.test(String(status || "").trim());

// Statuses that mean "did not convert AND the lead is actually closed out" —
// used for the day's Converted/Not-Converted KPI, as distinct from Pending
// (still open, no verdict yet).
const CLOSED_LOST_RE = /^(not interested|lost|invalid|rejected|dead|dropped|closed|unqualified|spam|do not contact)$/i;
const isClosedLost = (status, isClosedFlag) => CLOSED_LOST_RE.test(String(status || "").trim()) || !!isClosedFlag;

// Fields needed by the table row AND by LeadJourneyDrawer/RecordingsDrawer
// when a row is clicked — returning them inline means the drawer opens
// immediately with no second fetch, same as AdminLeadsPage already does.
const LEAD_SELECT =
  "name mobile primaryPhone secondaryPhone email user status temperature leadCategory " +
  "source campaign industry service value createdAt updatedAt closedAt isClosed invalidStage " +
  "callHistory scheduledCalls meetingRemarks notInterestedReason";

function normalizeMobileTail(v) {
  return String(v || "").replace(/\D/g, "").slice(-10);
}

/**
 * @param {object} opts
 * @param {string|ObjectId} opts.company
 * @param {string} [opts.date]        Back-compat single-day mode — ISO date
 * @param {string} [opts.dateFrom]    Range mode — ISO date, inclusive
 * @param {string} [opts.dateTo]      Range mode — ISO date, inclusive (defaults to dateFrom)
 * @param {boolean} [opts.allTime]    Skip date filtering entirely — every lead
 * @param {string|ObjectId} [opts.agentId]
 * @param {string} [opts.source]
 * @param {string} [opts.status]      "new" | "followups" | "overdue" | "converted" | "notConverted" | "pending" | "" (all)
 * @param {string} [opts.temperature]
 * @param {string} [opts.search]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=25]
 * @param {object} [opts.leadScope={}]
 */
async function getLeadInsights({
  company, date, dateFrom, dateTo, allTime = false,
  agentId, source, status = "", temperature, search,
  page = 1, limit = 25, leadScope = {},
} = {}) {
  const now = new Date();

  // FIX: this used to be hardcoded to a single IST day (getISTDayBounds(date))
  // with no way to widen it — every lead not touched on that exact day was
  // invisible, and there was no way to just browse the full lead list. Now
  // supports three modes:
  //   allTime               → no date bound at all, every lead in scope
  //   dateFrom + dateTo     → inclusive range, each end resolved to its own
  //                           IST day boundary so "21 Aug – 25 Aug" behaves
  //                           the same way a single day always has
  //   date (or nothing)     → back-compat single-day mode, unchanged behavior
  let rangeStart = null, rangeEnd = null;
  if (!allTime) {
    if (dateFrom) {
      rangeStart = getISTDayBounds(dateFrom).dayStart;
      rangeEnd   = getISTDayBounds(dateTo || dateFrom).dayEnd;
    } else {
      const bounds = getISTDayBounds(date);
      rangeStart = bounds.dayStart;
      rangeEnd   = bounds.dayEnd;
    }
  }

  const baseFilter = mergeLeadScope({ company, mergedInto: null }, leadScope);
  const extraFilters = [];
  if (agentId) extraFilters.push({ user: agentId });
  if (source) extraFilters.push({ $or: [{ source }, { campaign: source }] });
  if (temperature) extraFilters.push({ $or: [{ temperature }, { leadCategory: temperature }] });

  // "Of the range" — created, called, followed-up, or closed within it.
  // In allTime mode this is simply omitted below, so every lead in scope
  // matches regardless of any date on it.
  const rangeCondition = rangeStart && {
    $or: [
      { createdAt: { $gte: rangeStart, $lte: rangeEnd } },
      { closedAt:  { $gte: rangeStart, $lte: rangeEnd } },
      { "callHistory.calledAt":      { $gte: rangeStart, $lte: rangeEnd } },
      { "scheduledCalls.scheduledAt": { $gte: rangeStart, $lte: rangeEnd } },
    ],
  };

  if (search && search.trim()) {
    const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    extraFilters.push({ $or: [{ name: re }, { mobile: re }, { primaryPhone: re }, { email: re }] });
  }


  // FIX: this used to spread `...baseFilter` and then set its OWN `$and` key
  // on the same object literal. baseFilter is itself `{ $and: [...] }` for
  // any plain "admin" caller (mergeLeadScope wraps it that way to combine the
  // company/mergedInto filter with the per-admin lead-visibility scope) — so
  // the spread's `$and` key got silently overwritten by the one set right
  // after it (later keys win in object literals), discarding the company
  // filter entirely for that role. Building the combined filter as a single
  // $and ARRAY instead means no key can ever collide, regardless of what
  // shape mergeLeadScope() or the caller's own filters happen to be.
  const dayFilter = { $and: [baseFilter, ...(rangeCondition ? [rangeCondition] : []), ...extraFilters] };

  const allLeads = await Lead.find(dayFilter)
    .select(LEAD_SELECT)
    .populate("user", "name")
    .lean();

  // Helper — true when no range bound is set (allTime) or the value falls
  // within [rangeStart, rangeEnd]. Centralizes the allTime-vs-bounded check
  // so every per-lead calculation below reads the same way regardless of mode.
  const inRange = (val) => {
    if (!val) return false;
    if (!rangeStart) return true; // allTime — everything counts
    const d = new Date(val);
    return d >= rangeStart && d <= rangeEnd;
  };

  // ── Per-lead derived fields, scoped to the selected range (a day, a custom
  // range, or — in allTime mode — the lead's entire history) ────────────────
  const withDayData = allLeads.map((l) => {
    const callHistory = Array.isArray(l.callHistory) ? l.callHistory : [];
    const scheduledCalls = Array.isArray(l.scheduledCalls) ? l.scheduledCalls : [];

    const callsToday = callHistory.filter((c) => inRange(c.calledAt));
    const connectedToday = callsToday.filter(
      (c) => /connect|answer|interested|follow/i.test(c.outcome || "") && !/not\s*answer|missed|reject|busy|unreach/i.test(c.outcome || "")
    );
    const followUpsToday = scheduledCalls.filter((f) => inRange(f.scheduledAt));
    const overdueFollowUps = scheduledCalls.filter(
      (f) => !f.done && f.scheduledAt && new Date(f.scheduledAt) < now
    );
    const nextFollowUp = scheduledCalls
      .filter((f) => !f.done && f.scheduledAt)
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0] || null;
    const lastCall = [...callHistory].sort((a, b) => new Date(b.calledAt || 0) - new Date(a.calledAt || 0))[0] || null;

    const createdToday = inRange(l.createdAt);
    const closedToday  = inRange(l.closedAt);
    const converted    = isConverted(l.status);
    const closedLost   = isClosedLost(l.status, l.isClosed);

    let bucket = "pending";
    if (converted && closedToday) bucket = "converted";
    else if (closedLost && closedToday) bucket = "notConverted";
    else if (overdueFollowUps.length > 0) bucket = "overdue";
    else if (followUpsToday.length > 0) bucket = "followups";
    else if (createdToday) bucket = "new";

    // ── Status reason — a human-readable "why is this lead in this state" ────
    // Previously the categorise()/pickReasonText() logic only fed the
    // aggregate top-reasons chart and was discarded per-lead. Attaching it
    // here means every lead carries its own explanation, visible in the
    // table without opening anything.
    const totalCalls = callHistory.length;
    const totalConnected = callHistory.filter(
      (c) => /connect|answer|interested|follow/i.test(c.outcome || "") && !/not\s*answer|missed|reject|busy|unreach/i.test(c.outcome || "")
    ).length;
    const pendingFollowUps = scheduledCalls.filter((f) => !f.done).length;
    const completedFollowUps = scheduledCalls.filter((f) => f.done).length;

    let statusReason;
    if (converted) {
      statusReason = `Converted after ${totalCalls} call${totalCalls === 1 ? "" : "s"} (${totalConnected} connected)` +
        (lastCall?.remark ? ` — last note: "${lastCall.remark}"` : "");
    } else if (closedLost) {
      const text = pickReasonText(l, lastCall?.remark || lastCall?.outcome || "");
      const reason = categorise(text, l.status);
      statusReason = `Not converted — ${reason}` + (lastCall?.remark ? ` ("${lastCall.remark}")` : "");
    } else if (totalCalls === 0) {
      statusReason = "No calls made yet";
    } else if (overdueFollowUps.length > 0) {
      statusReason = `${overdueFollowUps.length} overdue follow-up${overdueFollowUps.length === 1 ? "" : "s"} — last contacted ${lastCall?.calledAt ? new Date(lastCall.calledAt).toLocaleDateString("en-IN") : "unknown"}`;
    } else if (pendingFollowUps > 0) {
      statusReason = `In progress — ${totalCalls} call${totalCalls === 1 ? "" : "s"} so far, ${pendingFollowUps} follow-up${pendingFollowUps === 1 ? "" : "s"} scheduled`;
    } else {
      statusReason = `${totalCalls} call${totalCalls === 1 ? "" : "s"} made, ${totalConnected} connected — no follow-up scheduled`;
    }

    return {
      ...l,
      _callsToday: callsToday.length,
      _connectedToday: connectedToday.length,
      _remarksToday: callsToday.filter((c) => c.remark).length,
      _lastResponse: lastCall?.outcome || lastCall?.remark || null,
      _lastActivity: lastCall?.calledAt || l.updatedAt,
      _nextFollowUp: nextFollowUp?.scheduledAt || null,
      _createdToday: createdToday,
      _closedToday: closedToday,
      _overdueCount: overdueFollowUps.length,
      _bucket: bucket,
      _statusReason: statusReason,
      _totalCalls: totalCalls,
      _totalConnected: totalConnected,
      _totalRemarks: callHistory.filter((c) => c.remark).length,
      _pendingFollowUps: pendingFollowUps,
      _completedFollowUps: completedFollowUps,
    };
  });

  // ── KPI summary (whole day, unfiltered by the table's status tab) ──────────
  const summary = {
    newLeads:        withDayData.filter((l) => l._createdToday).length,
    followUps:       withDayData.filter((l) => l._bucket === "followups" || l._bucket === "overdue").length,
    callsMade:       withDayData.reduce((sum, l) => sum + l._callsToday, 0),
    connectedCalls:  withDayData.reduce((sum, l) => sum + l._connectedToday, 0),
    unansweredCalls: withDayData.reduce((sum, l) => sum + (l._callsToday - l._connectedToday), 0),
    converted:       withDayData.filter((l) => l._bucket === "converted").length,
    notConverted:    withDayData.filter((l) => l._bucket === "notConverted").length,
    pending:         withDayData.filter((l) => l._bucket === "pending" || l._bucket === "new").length,
  };

  // ── Apply the requested tab filter for the table itself ─────────────────────
  const STATUS_TO_BUCKET = {
    new: "new", followups: "followups", overdue: "overdue",
    converted: "converted", notConverted: "notConverted", pending: "pending",
  };
  let filtered = withDayData;
  if (status && STATUS_TO_BUCKET[status]) {
    filtered = withDayData.filter((l) => l._bucket === STATUS_TO_BUCKET[status]);
  }

  filtered.sort((a, b) => new Date(b._lastActivity || 0) - new Date(a._lastActivity || 0));

  const total = filtered.length;
  const start = (Math.max(page, 1) - 1) * limit;
  const pageLeads = filtered.slice(start, start + limit);

  // ── Follow-ups within the selected range (independent of the table's own
  // pagination/tab) ───────────────────────────────────────────────────────────
  const followUps = withDayData
    .filter((l) => {
      const scheduledCalls = Array.isArray(l.scheduledCalls) ? l.scheduledCalls : [];
      return scheduledCalls.some((f) => inRange(f.scheduledAt));
    })
    .map((l) => {
      const f = (l.scheduledCalls || [])
        .filter((sc) => inRange(sc.scheduledAt))
        .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0];
      const lastCall = [...(l.callHistory || [])].sort((a, b) => new Date(b.calledAt || 0) - new Date(a.calledAt || 0))[0];
      return {
        leadId: l._id,
        leadName: l.name,
        agent: l.user?.name || "Unassigned",
        followUpTime: f?.scheduledAt || null,
        previousResponse: lastCall?.outcome || null,
        lastRemark: lastCall?.remark || null,
        status: f?.done ? "Completed" : (f && new Date(f.scheduledAt) < now ? "Overdue" : "Pending"),
      };
    });

  // ── Activity Timeline ────────────────────────────────────────────────────────
  // In allTime/wide-range mode this can get very large across thousands of
  // leads — capped below to the most recent TIMELINE_CAP events so it stays
  // useful (a scrollable feed) instead of dumping an entire company's history.
  const TIMELINE_CAP = 300;
  const timeline = [];
  for (const l of withDayData) {
    if (l._createdToday) {
      timeline.push({ time: l.createdAt, type: "New Lead", leadName: l.name, detail: null });
    }
    for (const c of l.callHistory || []) {
      if (inRange(c.calledAt)) {
        timeline.push({ time: c.calledAt, type: "Call", leadName: l.name, detail: c.outcome || c.remark || null });
        if (c.remark) timeline.push({ time: c.calledAt, type: "Remark", leadName: l.name, detail: c.remark });
      }
    }
    for (const f of l.scheduledCalls || []) {
      if (inRange(f.scheduledAt)) {
        timeline.push({ time: f.scheduledAt, type: "Follow-up Scheduled", leadName: l.name, detail: f.note || null });
      }
    }
    if (l._closedToday) {
      timeline.push({
        time: l.closedAt || l.updatedAt,
        type: "Status Changed",
        leadName: l.name,
        detail: `→ ${l.status}`,
      });
    }
  }
  timeline.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0)); // newest first when capping
  const timelineTruncated = timeline.length > TIMELINE_CAP;
  const cappedTimeline = timeline.slice(0, TIMELINE_CAP).sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));

  // ── Conversion Analysis (fast keyword pass only — no AI here) ──────────────
  const closedLostToday = withDayData.filter((l) => l._bucket === "notConverted");
  const reasonCounts = {};
  for (const l of closedLostToday) {
    const text = pickReasonText(l, "");
    const reason = categorise(text, l.status);
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  const totalClosed = summary.converted + summary.notConverted;
  const conversionAnalysis = {
    totalLeads: total,
    converted: summary.converted,
    notConverted: summary.notConverted,
    pending: summary.pending,
    conversionRate: totalClosed ? Math.round((summary.converted / totalClosed) * 1000) / 10 : 0,
    nonConversionRate: totalClosed ? Math.round((summary.notConverted / totalClosed) * 1000) / 10 : 0,
    reasons: Object.entries(reasonCounts)
      .map(([reason, count]) => ({
        reason, count,
        percent: closedLostToday.length ? Math.round((count / closedLostToday.length) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count),
  };

  return {
    mode: allTime ? "all" : (dateFrom ? "range" : "day"),
    dateFrom: rangeStart ? rangeStart.toISOString().slice(0, 10) : null,
    dateTo:   rangeEnd   ? rangeEnd.toISOString().slice(0, 10)   : null,
    summary,
    leads: pageLeads,
    pagination: { page: Math.max(page, 1), limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
    followUps,
    timeline: cappedTimeline,
    timelineTruncated,
    conversionAnalysis,
  };
}

module.exports = { getLeadInsights };
