// controllers/leadAIAnalysisController.js
// ─────────────────────────────────────────────────────────────────────────────
// API handlers for AI Lead Outcome Intelligence.
// Company isolation: same pattern as all other SkyUp CRM controllers.
// Auth: uses existing protectAdmin / protect middleware — no bypass.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose       = require("mongoose");
const Lead           = require("../models/Leads");
const LeadAIAnalysis = require("../models/LeadAIAnalysis");
const { enqueueLeadAnalysis, runAnalysisBatch } = require("../jobs/leadAIAnalysisJob");
const { buildLeadTimeline }    = require("../services/ai/leadTimeline.service");
const { calculateLeadMetrics } = require("../services/ai/leadMetrics.service");
const { diagnoseLead }         = require("../services/ai/leadDiagnosis.service");

// ── Helper: resolve companyId from request (admin or user) ───────────────────
function getCompanyId(req) {
  return req.admin?.company || req.user?.company || null;
}

// ── Helper: verify the lead belongs to this company ──────────────────────────
async function verifyLeadCompany(leadId, companyId) {
  if (!mongoose.isValidObjectId(leadId)) throw new Error("Invalid lead ID");
  const lead = await Lead.findOne({ _id: leadId, company: companyId })
    .select("_id company")
    .lean();
  if (!lead) throw new Error("Lead not found or access denied");
  return lead;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/leads/:leadId/ai-analysis
// Returns stored analysis. If none exists, returns 404 (client can show
// "Analyze" button). Does NOT trigger a new analysis.
// ─────────────────────────────────────────────────────────────────────────────
const getAIAnalysis = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ success: false, message: "Unauthorized" });

    await verifyLeadCompany(req.params.leadId, companyId);

    const analysis = await LeadAIAnalysis.findOne({ leadId: req.params.leadId })
      .lean();

    if (!analysis) {
      return res.status(404).json({
        success: false,
        message: "No AI analysis found for this lead. Click Re-analyze to generate one.",
        hasAnalysis: false,
      });
    }

    return res.json({ success: true, hasAnalysis: true, analysis });
  } catch (err) {
    console.error("[leadAI:get]", err.message);
    return res.status(err.message.includes("access denied") ? 403 : 500).json({
      success: false,
      message: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/leads/:leadId/ai-analysis
// Enqueues a background analysis job.
// Returns immediately — client polls GET to check when done.
// ─────────────────────────────────────────────────────────────────────────────
const createAIAnalysis = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ success: false, message: "Unauthorized" });

    await verifyLeadCompany(req.params.leadId, companyId);

    const triggeredBy = req.body?.triggeredBy || "manual";
    await enqueueLeadAnalysis(req.params.leadId, companyId, triggeredBy);

    return res.status(202).json({
      success: true,
      message: "Analysis queued. Results will be ready in a moment.",
      status:  "pending",
    });
  } catch (err) {
    console.error("[leadAI:create]", err.message);
    return res.status(err.message.includes("access denied") ? 403 : 500).json({
      success: false,
      message: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/leads/:leadId/ai-analysis/reanalyze
// Same as POST but always resets to pending even if done.
// Also triggers a sync re-run so the user doesn't wait for the next cron tick.
// ─────────────────────────────────────────────────────────────────────────────
const reanalyzeAIAnalysis = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ success: false, message: "Unauthorized" });

    await verifyLeadCompany(req.params.leadId, companyId);

    // Force reset to pending
    await LeadAIAnalysis.findOneAndUpdate(
      { leadId: req.params.leadId },
      {
        $set: {
          leadId:     req.params.leadId,
          companyId,
          status:     "pending",
          triggeredBy:"manual",
          generatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Kick off background batch immediately (non-blocking)
    runAnalysisBatch().catch(e => console.error("[reanalyze] batch error:", e.message));

    return res.status(202).json({
      success: true,
      message: "Re-analysis started. Refresh in a few seconds.",
      status:  "pending",
    });
  } catch (err) {
    console.error("[leadAI:reanalyze]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/leads/ai-report
// Management report: overview across all leads in the company.
// ─────────────────────────────────────────────────────────────────────────────
const getAIReport = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const analyses = await LeadAIAnalysis.find({
      companyId,
      status: "done",
    })
      .select(
        "leadId outcome leadHealth conversionProbability primaryReason secondaryReasons metrics generatedAt"
      )
      .lean();

    // Aggregate
    const summary = {
      total:    analyses.length,
      healthy:  analyses.filter(a => a.leadHealth === "HEALTHY").length,
      atRisk:   analyses.filter(a => a.leadHealth === "AT_RISK").length,
      critical: analyses.filter(a => a.leadHealth === "CRITICAL").length,
      lost:     analyses.filter(a => a.leadHealth === "LOST").length,
    };

    // Top primary reason codes
    const reasonCount = {};
    for (const a of analyses) {
      const code = a.primaryReason?.code;
      if (code) reasonCount[code] = (reasonCount[code] || 0) + 1;
    }
    const topProblems = Object.entries(reasonCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([code, count]) => ({ code, count }));

    // Responsibility distribution
    const respCount = { SALESPERSON: 0, CUSTOMER: 0, COMPANY_PRODUCT: 0, SHARED: 0, UNKNOWN: 0 };
    for (const a of analyses) {
      const rt = a.primaryReason?.responsibleType;
      if (rt && respCount[rt] !== undefined) respCount[rt]++;
    }

    // Per-employee breakdown
    const employeeMap = {};
    for (const a of analyses) {
      const uid  = String(a.primaryReason?.responsibleUserId || "unknown");
      const name = a.primaryReason?.responsibleName || "Unknown";
      if (!employeeMap[uid]) {
        employeeMap[uid] = { userId: uid, name, totalLeads: 0, atRisk: 0, lost: 0, poorFollowUp: 0 };
      }
      const em = employeeMap[uid];
      em.totalLeads++;
      if (a.leadHealth === "AT_RISK")  em.atRisk++;
      if (a.leadHealth === "LOST")     em.lost++;
      if (a.primaryReason?.code === "POOR_FOLLOW_UP") em.poorFollowUp++;
    }

    return res.json({
      success: true,
      report: {
        summary,
        topProblems,
        responsibilityDistribution: respCount,
        employeeBreakdown: Object.values(employeeMap),
      },
    });
  } catch (err) {
    console.error("[leadAI:report]", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lead/:leadId/timeline  (and /api/lead/admin/:leadId/timeline)
// Full chronological journey for one lead: new-lead arrival, template sends
// (with rendered content), Telegram notifications, calls, follow-ups,
// meetings, stage changes and the WhatsApp conversation thread — everything
// merged and sorted by actual date/time. Powers the "Lead Journey Timeline"
// view in Lead Insights / the lead drawer.
// ─────────────────────────────────────────────────────────────────────────────
const getLeadTimeline = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ success: false, message: "Unauthorized" });

    await verifyLeadCompany(req.params.leadId, companyId);

    const { timeline } = await buildLeadTimeline(req.params.leadId, companyId);

    return res.json({ success: true, timeline });
  } catch (err) {
    console.error("[leadAI:timeline]", err.message);
    return res.status(err.message.includes("access denied") ? 403 : 500).json({
      success: false,
      message: err.message,
    });
  }
};

module.exports = {
  getAIAnalysis,
  createAIAnalysis,
  reanalyzeAIAnalysis,
  getAIReport,
  getLeadTimeline,
};
