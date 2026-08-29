// controllers/nurtureController.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin CRUD for NurtureRule. Every query/write is scoped to req.admin's own
// company — there is no cross-company listing here, by design (mirrors the
// scoping already used in reportController.js).
//
// NOTE: creating/enabling a rule here does NOT by itself turn the feature on
// for a company — that still requires
// Company.devOverrides.featureToggles.leadNurtureSequence = true, set from
// the Developer > Company Details panel. This keeps the "only one company"
// requirement enforced in one place (the entitlement, not the rule data).
//
// MANUAL TRIGGER ENDPOINTS (for testing without waiting for the 11 AM cron):
//   POST /api/nurture/run              — runs the full cron check right now
//   POST /api/nurture/trigger/:leadId  — fires rules for one specific lead
// ─────────────────────────────────────────────────────────────────────────────

const NurtureRule = require("../models/NurtureRule");
const WhatsAppTemplate = require("../models/WhatsAppTemplate");
const WhatsAppSendLog = require("../models/WhatsAppSendLog");
const { syncTemplatesForCompany, probeTemplateEndpoints, fetchRaw } = require("../services/msg91TemplateService");
const { escapeRegex } = require("../utils/escapeRegex");
const { runNurtureSequenceCheck, triggerNurtureForLead } = require("../jobs/nurtureSequenceJob");

function resolveCompany(req) {
  return req.callerCompany || req.admin?.company?._id || req.admin?.company;
}

// ── GET /api/nurture/rules ────────────────────────────────────────────────────
const listRules = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved from token" });

    const rules = await NurtureRule.find({ company }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, rules });
  } catch (err) {
    console.error("[nurtureController.listRules]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/nurture/rules ───────────────────────────────────────────────────
const createRule = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved from token" });

    const { name, trigger, action, repeatEveryDays, enabled } = req.body;
    if (!name || !trigger || trigger.minDaysSinceLastTouch == null) {
      return res.status(400).json({ message: "name and trigger.minDaysSinceLastTouch are required" });
    }

    const rule = await NurtureRule.create({
      company,
      name,
      trigger,
      action: action || {},
      repeatEveryDays: repeatEveryDays || null,
      enabled: enabled !== false,
    });

    // Warn (don't block — a deliberate multi-touch sequence for one status is
    // legitimate) when this creates a SECOND enabled rule for the same status
    // stage. nurtureSequenceJob.js's dedup is keyed per-rule, so two rules
    // targeting the same status independently evaluate — and independently
    // log, sent or skipped — every matching lead. Surfacing this now, at
    // creation time, beats discovering it later as hundreds of doubled rows
    // in the WhatsApp send-log report.
    let warning = null;
    const stage = rule.action?.whatsapp?.statusStage;
    if (stage && rule.enabled) {
      const siblingCount = await NurtureRule.countDocuments({
        company,
        enabled: true,
        _id: { $ne: rule._id },
        "action.whatsapp.statusStage": stage,
      });
      if (siblingCount > 0) {
        warning = `${siblingCount} other enabled rule(s) already target status "${stage}". Every lead in that status will be evaluated by all of them — if this isn't a deliberate multi-touch sequence, disable the extras.`;
      }
    }

    res.status(201).json({ success: true, rule, warning });
  } catch (err) {
    console.error("[nurtureController.createRule]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── PATCH /api/nurture/rules/:id ──────────────────────────────────────────────
const updateRule = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved from token" });

    const rule = await NurtureRule.findOneAndUpdate(
      { _id: req.params.id, company }, // company filter prevents cross-tenant edits
      { $set: req.body },
      { new: true }
    );
    if (!rule) return res.status(404).json({ message: "Rule not found" });

    // Same warning as createRule — an update can just as easily introduce a
    // duplicate-stage situation (e.g. re-enabling a previously-disabled rule,
    // or changing statusStage to match an existing one).
    let warning = null;
    const stage = rule.action?.whatsapp?.statusStage;
    if (stage && rule.enabled) {
      const siblingCount = await NurtureRule.countDocuments({
        company,
        enabled: true,
        _id: { $ne: rule._id },
        "action.whatsapp.statusStage": stage,
      });
      if (siblingCount > 0) {
        warning = `${siblingCount} other enabled rule(s) already target status "${stage}". Every lead in that status will be evaluated by all of them — if this isn't a deliberate multi-touch sequence, disable the extras.`;
      }
    }

    res.json({ success: true, rule, warning });
  } catch (err) {
    console.error("[nurtureController.updateRule]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/nurture/rules/:id ─────────────────────────────────────────────
const deleteRule = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved from token" });

    const rule = await NurtureRule.findOneAndDelete({ _id: req.params.id, company });
    if (!rule) return res.status(404).json({ message: "Rule not found" });

    res.json({ success: true });
  } catch (err) {
    console.error("[nurtureController.deleteRule]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/nurture/templates/sync ─────────────────────────────────────────
// Pulls every approved WhatsApp template from MSG91 into the local cache so
// the nurture builder can offer a real dropdown and the job can verify a
// template exists before sending.
const syncTemplates = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved from token" });

    const result = await syncTemplatesForCompany(company);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[nurtureController.syncTemplates]", err.message);
    // The message includes the list of endpoints tried — surface it so the
    // admin can forward it to MSG91 support if none worked.
    res.status(502).json({ success: false, message: err.message });
  }
};

// ── GET /api/nurture/templates ───────────────────────────────────────────────
// Lists cached templates. Optional filters:
//   ?stage=awareness      only that funnel stage
//   ?nurtureOnly=true     exclude legacy templates
//   ?search=healthcare    substring match on name
const listTemplates = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved from token" });

    const q = { company };
    if (req.query.stage) q.funnelStage = String(req.query.stage).toLowerCase();
    if (String(req.query.nurtureOnly) === "true") q.isNurtureTemplate = true;
    if (req.query.search) {
      q.name = { $regex: escapeRegex(String(req.query.search)), $options: "i" };
    }

    const templates = await WhatsAppTemplate.find(q)
      .select("name language category status rawStatusField bodyVariableCount isNurtureTemplate funnelStage variation lastSyncedAt")
      .sort({ name: 1 })
      .limit(3000)
      .lean();

    const nurtureTpls = templates.filter((t) => t.isNurtureTemplate);
    const stats = {
      total:    templates.length,
      nurture:  nurtureTpls.length,
      approved: nurtureTpls.filter((t) => t.status === "APPROVED").length,
      pending:  nurtureTpls.filter((t) => t.status === "PENDING").length,
      rejected: nurtureTpls.filter((t) => t.status === "REJECTED").length,
      paused:   nurtureTpls.filter((t) => t.status === "PAUSED").length,
      // byStage counts ONLY approved templates — pending/rejected can't send
      byStage: nurtureTpls.reduce((acc, t) => {
        if (t.funnelStage && t.status === "APPROVED") acc[t.funnelStage] = (acc[t.funnelStage] || 0) + 1;
        return acc;
      }, {}),
      lastSyncedAt: templates[0]?.lastSyncedAt || null,
    };

    res.json({ success: true, stats, templates });
  } catch (err) {
    console.error("[nurtureController.listTemplates]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/nurture/templates/probe ─────────────────────────────────────────
// Diagnostic only — tries every candidate MSG91 endpoint and reports which
// responds with a template list. Run once, then pin the winner in Render as
// MSG91_TEMPLATES_API_URL so future syncs skip the probing.
// ── GET /api/nurture/templates/raw ────────────────────────────────────────────
// Returns the complete raw MSG91 response so we can see the exact shape and
// tune the parser. Remove or gate behind isDev after the shape is confirmed.
const rawTemplates = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved" });
    const result = await fetchRaw(company);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const probeTemplates = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved from token" });

    const results = await probeTemplateEndpoints(company);
    const winner = results.find((r) => r.works);
    res.json({
      success: true,
      winner: winner ? winner.url : null,
      hint: winner
        ? `Set MSG91_TEMPLATES_API_URL=${winner.url.replace(/\/[0-9]+$/, "/{number}")} in Render`
        : "No endpoint returned templates — ask MSG91 support for the correct URL.",
      results,
    });
  } catch (err) {
    console.error("[nurtureController.probeTemplates]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/nurture/run ─────────────────────────────────────────────────────
// Manually runs the full nurture cron check right now — useful for testing
// without waiting until 11:00 AM IST. Only works for the enabled company
// (6a22662b7aea6e4034f44aae); all others are silently no-ops inside the job.
const runNow = async (req, res) => {
  try {
    const result = await runNurtureSequenceCheck();
    res.json({ success: true, sent: result.sent });
  } catch (err) {
    console.error("[nurtureController.runNow]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /api/nurture/trigger/:leadId ─────────────────────────────────────────
// Fires the immediate nurture trigger for one specific lead at the lead's
// current status. Useful for debugging leads that didn't get nurtured after a
// status change. Body: { status } — override the status to test (optional;
// defaults to the lead's current status in the DB).
const triggerForLead = async (req, res) => {
  try {
    const { leadId } = req.params;
    const Lead = require("../models/Leads");

    const lead = await Lead.findById(leadId).select("status").lean();
    if (!lead) return res.status(404).json({ message: "Lead not found" });

    const status = req.body.status || lead.status;
    if (!status) return res.status(400).json({ message: "Lead has no status; pass status in body" });

    await triggerNurtureForLead(String(leadId), status);
    res.json({ success: true, leadId, status });
  } catch (err) {
    console.error("[nurtureController.triggerForLead]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/nurture/report ────────────────────────────────────────────────────
// Sent / Failed / Skipped counts + a paginated log, scoped to nurture sends
// only (channel: "nurture" — excludes manual blasts/campaigns, which have
// their own reporting elsewhere).
//
// Query params (all optional):
//   from, to     — ISO date strings, filters on createdAt
//   status       — "sent" | "failed" | "skipped" (omit for all)
//   ruleId       — filter to one nurture rule
//   page, limit  — pagination for the log list (default page=1, limit=50)
const getReport = async (req, res) => {
  try {
    const company = resolveCompany(req);
    if (!company) return res.status(400).json({ message: "Company not resolved from token" });

    const { from, to, status, ruleId } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const match = { company, channel: "nurture" };

    if (status && ["sent", "failed", "skipped"].includes(status)) {
      match.status = status;
    }
    if (ruleId) {
      match.ruleId = ruleId;
    }
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      // Extend a date-only "to" (e.g. "2026-08-29") to the end of that day —
      // otherwise it parses as midnight UTC and excludes the entire day it's
      // meant to include. Same fix already applied in bulkSendToLeads.
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    // ── Summary counts — always computed over the full date/rule filter,
    //    ignoring the `status` filter itself, so the UI can show all three
    //    tallies side-by-side regardless of which tab the user is viewing.
    const summaryMatch = { ...match };
    delete summaryMatch.status;

    const summaryAgg = await WhatsAppSendLog.aggregate([
      { $match: summaryMatch },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const summary = { sent: 0, failed: 0, skipped: 0, total: 0 };
    for (const row of summaryAgg) {
      if (row._id in summary) summary[row._id] = row.count;
      summary.total += row.count;
    }

    // ── Per-rule breakdown — helps spot which specific nurture rule is
    //    failing, rather than just an undifferentiated company-wide total.
    const byRuleAgg = await WhatsAppSendLog.aggregate([
      { $match: summaryMatch },
      {
        $group: {
          _id: { ruleId: "$ruleId", ruleName: "$ruleName", status: "$status" },
          count: { $sum: 1 },
        },
      },
    ]);

    const byRuleMap = {};
    for (const row of byRuleAgg) {
      const key = String(row._id.ruleId || "unassigned");
      if (!byRuleMap[key]) {
        byRuleMap[key] = {
          ruleId: row._id.ruleId,
          ruleName: row._id.ruleName || "Unassigned",
          sent: 0, failed: 0, skipped: 0, total: 0,
        };
      }
      byRuleMap[key][row._id.status] = row.count;
      byRuleMap[key].total += row.count;
    }
    const byRule = Object.values(byRuleMap).sort((a, b) => b.total - a.total);

    // ── Paginated log list (respects the `status` filter, unlike summary) ──────
    const [logs, totalMatching] = await Promise.all([
      WhatsAppSendLog.find(match)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("lead phone name templateName content status reason ruleId ruleName sentByName createdAt")
        .lean(),
      WhatsAppSendLog.countDocuments(match),
    ]);

    res.json({
      success: true,
      summary,
      byRule,
      logs,
      pagination: {
        page,
        limit,
        total: totalMatching,
        hasMore: page * limit < totalMatching,
      },
    });
  } catch (err) {
    console.error("[nurtureController.getReport]", err.message);
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  syncTemplates,
  listTemplates,
  probeTemplates,
  rawTemplates,
  runNow,
  triggerForLead,
  getReport,
};
