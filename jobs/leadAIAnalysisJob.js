// jobs/leadAIAnalysisJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Background analysis runner. Uses Redis SETNX for dedup (same pattern as the
// existing WhatsApp dedup lock — no BullMQ needed, consistent with codebase).
//
// Queue model:
//   • A "pending" LeadAIAnalysis doc is the queue — the cron picks up docs
//     with status:"pending" and processes them serially, max BATCH_SIZE per
//     tick, preventing runaway API spend.
//   • Redis lock prevents two ticks overlapping for the same lead.
//   • Triggered by: manual re-analyze | call | whatsapp | followup | meeting |
//     stage change — via enqueueLeadAnalysis() helper exported below.
//
// HOW TO ACTIVATE — wire in server.js:
//   const { startLeadAIAnalysisJob } = require('./jobs/leadAIAnalysisJob');
//   startLeadAIAnalysisJob();
// ─────────────────────────────────────────────────────────────────────────────

const cron            = require("node-cron");
const LeadAIAnalysis  = require("../models/LeadAIAnalysis");
const { buildLeadTimeline }   = require("../services/ai/leadTimeline.service");
const { calculateLeadMetrics } = require("../services/ai/leadMetrics.service");
const { diagnoseLead }         = require("../services/ai/leadDiagnosis.service");
const { redisClient }          = require("../middlewares/rateLimiter");

const ANALYSIS_VERSION = "1.0";
const BATCH_SIZE       = 3;  // max leads to analyze per cron tick (control API cost)
const LOCK_TTL_SECONDS = 60; // Redis lock TTL per lead

// ── Redis dedup lock (same pattern as acquireWaDedupLock) ─────────────────────
async function acquireAnalysisLock(leadId) {
  try {
    if (!redisClient.isReady) return true; // fail open if Redis down
    const result = await redisClient.set(
      `ai:analysis:${leadId}`,
      "1",
      { NX: true, EX: LOCK_TTL_SECONDS }
    );
    return result === "OK";
  } catch (err) {
    console.error("[leadAIJob] Redis lock error:", err.message);
    return true; // fail open
  }
}

async function releaseAnalysisLock(leadId) {
  try {
    if (!redisClient.isReady) return;
    await redisClient.del(`ai:analysis:${leadId}`);
  } catch { /* non-fatal */ }
}

// ── Enqueue a lead for analysis (call from controllers/events) ────────────────
/**
 * Upsert a "pending" analysis doc for this lead.
 * If one already exists and is processing, skip (dedup).
 * @param {string|ObjectId} leadId
 * @param {string|ObjectId} companyId
 * @param {string}          triggeredBy  e.g. "call" | "whatsapp" | "manual" | "followup" | "stage_change"
 */
async function enqueueLeadAnalysis(leadId, companyId, triggeredBy = "event") {
  try {
    const existing = await LeadAIAnalysis.findOne({ leadId }).lean();

    // Don't overwrite if currently processing
    if (existing?.status === "processing") {
      console.log(`[leadAIJob] Lead ${leadId} already processing — skipped enqueue`);
      return;
    }

    await LeadAIAnalysis.findOneAndUpdate(
      { leadId },
      {
        $set: {
          leadId,
          companyId,
          triggeredBy,
          status:          "pending",
          analysisVersion: ANALYSIS_VERSION,
          generatedAt:     new Date(),
        },
      },
      { upsert: true, new: true }
    );
    console.log(`[leadAIJob] Enqueued analysis for lead ${leadId} (trigger: ${triggeredBy})`);
  } catch (err) {
    console.error("[leadAIJob] enqueueLeadAnalysis error:", err.message);
  }
}

// ── Process one lead ──────────────────────────────────────────────────────────
async function processOneLead(analysis) {
  const leadId    = analysis.leadId;
  const companyId = analysis.companyId;

  // Acquire lock
  const locked = await acquireAnalysisLock(leadId);
  if (!locked) {
    console.log(`[leadAIJob] Lead ${leadId} locked by another process — skip`);
    return;
  }

  try {
    // Mark as processing
    await LeadAIAnalysis.updateOne({ leadId }, { $set: { status: "processing" } });

    // Build timeline + metrics
    const { lead, timeline, rawData } = await buildLeadTimeline(leadId, companyId);
    const metrics = calculateLeadMetrics(lead, timeline, rawData);

    // Call AI
    const diagnosis = await diagnoseLead({ lead, timeline, metrics, rawData });

    // Save result
    await LeadAIAnalysis.findOneAndUpdate(
      { leadId },
      {
        $set: {
          companyId,
          outcome:               diagnosis.outcome,
          currentStage:          diagnosis.currentStage,
          leadHealth:            diagnosis.leadHealth,
          conversionProbability: diagnosis.conversionProbability,
          primaryReason:         diagnosis.primaryReason,
          secondaryReasons:      diagnosis.secondaryReasons,
          explanation:           diagnosis.explanation,
          evidence:              diagnosis.evidence,
          communicationAnalysis: diagnosis.communicationAnalysis,
          metrics,
          recommendedActions:    diagnosis.recommendedActions,
          model:                 diagnosis.model,
          analysisVersion:       ANALYSIS_VERSION,
          generatedAt:           new Date(),
          status:                "done",
          errorMessage:          null,
          triggeredBy:           analysis.triggeredBy,
        },
      },
      { upsert: true }
    );

    console.log(`[leadAIJob] ✅ Analysis done for lead ${leadId} — health: ${diagnosis.leadHealth}, probability: ${diagnosis.conversionProbability}%`);
  } catch (err) {
    console.error(`[leadAIJob] ❌ Analysis failed for lead ${leadId}:`, err.message);
    await LeadAIAnalysis.updateOne(
      { leadId },
      { $set: { status: "failed", errorMessage: err.message } }
    );
  } finally {
    await releaseAnalysisLock(leadId);
  }
}

// ── Cron runner — every 2 minutes, pick up pending items ─────────────────────
async function runAnalysisBatch() {
  try {
    const pending = await LeadAIAnalysis.find({ status: "pending" })
      .sort({ generatedAt: 1 }) // oldest first
      .limit(BATCH_SIZE)
      .lean();

    if (!pending.length) return;
    console.log(`[leadAIJob] Processing ${pending.length} pending analysis job(s)...`);

    // Process serially to avoid hammering OpenAI
    for (const analysis of pending) {
      await processOneLead(analysis);
    }
  } catch (err) {
    console.error("[leadAIJob] Batch runner error:", err.message);
  }
}

function startLeadAIAnalysisJob() {
  // Every 2 minutes — process the pending queue
  cron.schedule("*/2 * * * *", () => {
    runAnalysisBatch().catch(e =>
      console.error("[leadAIJob] Cron error:", e.message)
    );
  });
  console.log("✅ Lead AI Analysis job started (every 2 min, batch size 3)");
}

module.exports = {
  startLeadAIAnalysisJob,
  enqueueLeadAnalysis,
  runAnalysisBatch,
};
