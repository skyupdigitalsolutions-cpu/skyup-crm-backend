// services/ai/leadMetrics.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Computes structured numeric and categorical metrics from a lead's raw CRM
// data. These metrics are passed alongside the timeline to the AI diagnosis
// service so it has concise quantitative signals without needing to re-parse
// the full timeline itself.
//
// Input:  lead (Mongoose doc), timeline (array), rawData (from buildLeadTimeline)
// Output: plain object of metrics — all fields are safe to JSON-serialise
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate how many days between two dates (floored).
 */
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.floor(Math.abs(new Date(b) - new Date(a)) / 86_400_000);
}

/**
 * Calculate lead metrics from raw CRM data.
 *
 * @param {object} lead      - Lead document (populated)
 * @param {Array}  timeline  - Ordered timeline events from buildLeadTimeline
 * @param {object} rawData   - { callHistory, scheduledCalls, meetingRemarks,
 *                              templateHistory, waMessages, waConversation,
 *                              transcribedCalls }
 * @returns {object} metrics
 */
function calculateLeadMetrics(lead, timeline, rawData) {
  const now = new Date();
  const createdAt = lead.createdAt ? new Date(lead.createdAt) : null;
  const leadAgeDays = createdAt ? daysBetween(createdAt, now) : null;

  // ── Call metrics ──────────────────────────────────────────────────────────
  const calls         = rawData.callHistory || [];
  const totalCalls    = calls.length;
  const answeredCalls = calls.filter(c =>
    c.outcome && !["No Answer", "Not Answered", "Missed", "Busy", "Failed"].includes(c.outcome)
  ).length;
  const notAnswered   = totalCalls - answeredCalls;
  const answerRate    = totalCalls > 0 ? Math.round((answeredCalls / totalCalls) * 100) : 0;

  const lastCallDate  = calls.length > 0
    ? new Date(calls[calls.length - 1].date || calls[calls.length - 1].createdAt)
    : null;
  const daysSinceLastCall = lastCallDate ? daysBetween(lastCallDate, now) : null;

  // Average call gap (days between consecutive calls)
  let avgCallGapDays = null;
  if (calls.length >= 2) {
    const gaps = [];
    for (let i = 1; i < calls.length; i++) {
      const d = daysBetween(
        calls[i - 1].date || calls[i - 1].createdAt,
        calls[i].date     || calls[i].createdAt
      );
      if (d !== null) gaps.push(d);
    }
    avgCallGapDays = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
  }

  // ── Follow-up metrics ─────────────────────────────────────────────────────
  const scheduled      = rawData.scheduledCalls || [];
  const pendingFollowUps = scheduled.filter(s => !s.done).length;
  const completedFollowUps = scheduled.filter(s => s.done).length;

  const overdueFollowUps = scheduled.filter(s => {
    if (s.done) return false;
    return s.scheduledAt && new Date(s.scheduledAt) < now;
  }).length;

  // ── WhatsApp metrics ──────────────────────────────────────────────────────
  const waMessages   = rawData.waMessages || [];
  const waSent       = waMessages.filter(m => m.direction === "outbound").length;
  const waReceived   = waMessages.filter(m => m.direction === "inbound").length;
  const waTemplates  = waMessages.filter(m => m.isTemplate).length;
  const waFreeText   = waSent - waTemplates;
  const waReplyRate  = waSent > 0 ? Math.round((waReceived / waSent) * 100) : 0;

  const templateHistory = rawData.templateHistory || [];
  const uniqueTemplates  = new Set(templateHistory.map(t => t.templateName).filter(Boolean)).size;

  // ── Meeting metrics ───────────────────────────────────────────────────────
  const meetings      = rawData.meetingRemarks || [];
  const totalMeetings = meetings.length;

  // ── Timeline event counts ─────────────────────────────────────────────────
  const timelineByType = {};
  for (const e of timeline) {
    timelineByType[e.type] = (timelineByType[e.type] || 0) + 1;
  }

  // ── First contact gap (lead created → first call) ─────────────────────────
  let firstContactGapDays = null;
  if (createdAt && calls.length > 0) {
    const firstCallDate = new Date(calls[0].date || calls[0].createdAt);
    firstContactGapDays = daysBetween(createdAt, firstCallDate);
  }

  // ── Days since last activity (any type) ──────────────────────────────────
  let lastActivityDate = createdAt;
  for (const e of timeline) {
    const d = e.date ? new Date(e.date) : null;
    if (d && d > lastActivityDate) lastActivityDate = d;
  }
  const daysSinceLastActivity = lastActivityDate ? daysBetween(lastActivityDate, now) : null;

  // ── Temperature and status ────────────────────────────────────────────────
  const temperature   = lead.temperature || "Cold";
  const status        = lead.status      || "New";
  const isClosed      = !!lead.isClosed;
  const closedReason  = lead.closeReason || null;

  return {
    // Lead age
    leadAgeDays,
    firstContactGapDays,
    daysSinceLastCall,
    daysSinceLastActivity,

    // Call metrics
    totalCalls,
    answeredCalls,
    notAnsweredCalls: notAnswered,
    answerRate,
    avgCallGapDays,

    // Follow-up
    pendingFollowUps,
    completedFollowUps,
    overdueFollowUps,

    // WhatsApp
    waSent,
    waReceived,
    waTemplates,
    waFreeText,
    waReplyRate,
    uniqueTemplatesSent: uniqueTemplates,

    // Meetings
    totalMeetings,

    // Timeline summary
    timelineEventCount: timeline.length,
    timelineByType,

    // Current state
    temperature,
    status,
    isClosed,
    closedReason,
  };
}

module.exports = { calculateLeadMetrics };
