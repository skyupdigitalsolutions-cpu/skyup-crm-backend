// services/leadAutoAnalysisService.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Automatic AI Intelligence for companies that have it switched on
// (Developer panel → Company → Features → "Auto AI Intelligence").
//
// Nobody has to click Analyse / Re-analyse. Two things keep analyses current:
//   1. WHEN A LEAD IS OPENED — no analysis yet, or new activity since the last one
//      → the analysis starts by itself and the panel just shows "in progress".
//   2. A BACKGROUND SWEEP (jobs/leadAutoAnalysisJob.js, every 5 min) — analyses leads
//      that were never analysed and refreshes leads with new activity.
//
// "New activity" = the lead was updated (remarks, calls, follow-ups, meetings, status…)
// or a WhatsApp message arrived, after the last analysis finished.
//
// Cost control: only leads active in the last LOOKBACK_DAYS are swept (older leads are
// analysed when opened), at most MAX_ENQUEUE_PER_TICK are queued per sweep, a lead is
// refreshed by the sweep at most every SWEEP_MIN_GAP (every VIEW_MIN_GAP when a person
// opens it), a failed analysis is retried at most MAX_AUTO_ATTEMPTS times, and nothing is
// queued while QUEUE_HIGH_WATER analyses are already waiting. The analysis job itself keeps
// its own batch cap (3 per 2 minutes).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const Lead                 = require("../models/Leads");
const Company              = require("../models/Company");
const LeadAIAnalysis       = require("../models/LeadAIAnalysis");
const WhatsAppConversation = require("../models/WhatsAppConversation");

const HOUR = 3600000, MIN = 60000, DAY = 24 * HOUR;
const SWEEP_MIN_GAP_MS    = 6 * HOUR;    // background refresh at most this often per lead
const VIEW_MIN_GAP_MS     = 30 * MIN;    // refresh when a person opens a lead with new activity
const RETRY_AFTER_MS      = 60 * MIN;    // wait before retrying a failed analysis
const LOOKBACK_DAYS       = 30;          // the sweep only looks at leads active this recently
const MAX_ENQUEUE_PER_TICK = 10;
const QUEUE_HIGH_WATER    = 30;
const MAX_AUTO_ATTEMPTS   = 3;

// ── Is the feature on for this company? ──────────────────────────────────────
async function isAutoAnalysisEnabled(companyId) {
  try {
    if (!companyId) return false;
    const { getCompanyEntitlements } = require("./entitlementService");
    const ent = await getCompanyEntitlements(String(companyId));
    return !!ent && ent.autoLeadAnalysis === true;
  } catch (e) {
    return false;
  }
}

// ── The rule: should this lead be analysed now? ──────────────────────────────
// analysis: the LeadAIAnalysis doc (or null); activityAt: latest lead update / WhatsApp message.
// (The sweep's database pipeline below expresses the same rule; the tests prove they agree.)
function analysisAction(analysis, activityAt, now = Date.now(), { minGapMs = SWEEP_MIN_GAP_MS } = {}) {
  if (!analysis) return "analyse";                                       // never analysed
  const status = analysis.status;
  if (status === "pending" || status === "processing") return "wait";    // already queued / running
  const at = analysis.generatedAt ? +new Date(analysis.generatedAt) : 0;
  if (status === "failed") return (analysis.autoAttempts || 0) < MAX_AUTO_ATTEMPTS && now - at >= RETRY_AFTER_MS ? "analyse" : "wait";
  if (status === "done") return activityAt && +new Date(activityAt) > at && now - at >= minGapMs ? "analyse" : "wait";
  return "wait";
}

// Latest sign of life on a lead: the lead itself, or its WhatsApp thread
async function leadActivityAt(leadId) {
  const [lead, conv] = await Promise.all([
    Lead.findOne({ _id: leadId }).select("updatedAt").lean(),
    WhatsAppConversation.findOne({ lead: leadId }).select("lastMessageAt").lean(),
  ]);
  const t = [lead && lead.updatedAt, conv && conv.lastMessageAt].filter(Boolean).map((d) => +new Date(d));
  return t.length ? new Date(Math.max(...t)) : null;
}

// Queue one lead and keep the retry counter honest. kick=true also starts the queue
// right away (used when a person is looking at the lead) instead of waiting for the next tick.
async function startAutoAnalysis(leadId, companyId, previous, { kick = false } = {}) {
  const jobs = require("../jobs/leadAIAnalysisJob");               // lazy: avoids load-order issues
  await jobs.enqueueLeadAnalysis(leadId, companyId, "auto");
  const wasFailed = previous && previous.status === "failed";
  await LeadAIAnalysis.updateOne({ leadId }, wasFailed ? { $inc: { autoAttempts: 1 } } : { $set: { autoAttempts: 0 } })
    .catch((e) => console.warn("[leadAuto] attempts bookkeeping failed:", e.message));
  if (kick) jobs.runAnalysisBatch().catch((e) => console.error("[leadAuto] batch error:", e.message));
}

async function enabledCompanyIds() {
  const rows = await Company.find({
    isActive: { $ne: false },
    "devOverrides.featureToggles.autoLeadAnalysis": true,
  }).select("_id").lean();
  return rows.map((r) => r._id);
}

// The sweep's selection, as one database pipeline (exported so it can be tested against the rule above)
function candidatePipeline(companyIds, now = Date.now()) {
  const window = new Date(now - LOOKBACK_DAYS * DAY);
  const gapCut = new Date(now - SWEEP_MIN_GAP_MS);
  const retryCut = new Date(now - RETRY_AFTER_MS);
  return [
    { $match: { company: { $in: companyIds }, mergedInto: null, updatedAt: { $gte: window } } },
    { $lookup: { from: "leadaianalyses", localField: "_id", foreignField: "leadId", as: "an" } },
    { $lookup: { from: "whatsappconversations", localField: "_id", foreignField: "lead", as: "cv" } },
    { $addFields: { a: { $arrayElemAt: ["$an", 0] }, never: { $eq: [{ $size: "$an" }, 0] }, activityAt: { $max: ["$updatedAt", { $max: "$cv.lastMessageAt" }] } } },
    { $match: { $expr: { $or: [
      "$never",
      { $and: [{ $eq: ["$a.status", "done"] }, { $gt: ["$activityAt", "$a.generatedAt"] }, { $lt: ["$a.generatedAt", gapCut] }] },
      { $and: [{ $eq: ["$a.status", "failed"] }, { $lt: [{ $ifNull: ["$a.autoAttempts", 0] }, MAX_AUTO_ATTEMPTS] }, { $lt: ["$a.generatedAt", retryCut] }] },
    ] } } },
    { $addFields: { priority: { $cond: ["$never", 0, 1] } } },        // never-analysed leads first
    { $sort: { priority: 1, updatedAt: -1 } },
    { $limit: MAX_ENQUEUE_PER_TICK },
    { $project: { _id: 1, company: 1, a: { status: "$a.status" } } },
  ];
}

// ── The sweep (called every 5 minutes by jobs/leadAutoAnalysisJob.js) ────────
async function runAutoAnalysisSweep() {
  if (!process.env.OPENAI_API_KEY) return { skipped: "no OPENAI_API_KEY" };
  const ids = await enabledCompanyIds();
  if (!ids.length) return { companies: 0, queued: 0 };

  const waiting = await LeadAIAnalysis.countDocuments({ companyId: { $in: ids }, status: "pending" });
  if (waiting >= QUEUE_HIGH_WATER) return { companies: ids.length, queued: 0, skipped: "queue full" };

  const picks = await Lead.aggregate(candidatePipeline(ids));
  let queued = 0;
  for (const p of picks) {
    await startAutoAnalysis(p._id, p.company, p.a && p.a.status ? { status: p.a.status } : null);
    queued++;
  }
  if (queued) console.log(`[leadAuto] queued AI analysis for ${queued} lead(s)`);
  return { companies: ids.length, queued };
}

module.exports = {
  isAutoAnalysisEnabled, analysisAction, leadActivityAt, startAutoAnalysis, runAutoAnalysisSweep, candidatePipeline,
  VIEW_MIN_GAP_MS, SWEEP_MIN_GAP_MS, MAX_ENQUEUE_PER_TICK, QUEUE_HIGH_WATER, MAX_AUTO_ATTEMPTS, LOOKBACK_DAYS,
};
