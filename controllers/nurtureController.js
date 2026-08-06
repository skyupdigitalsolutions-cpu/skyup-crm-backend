// controllers/nurtureController.js — NEW FILE
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
// ─────────────────────────────────────────────────────────────────────────────

const NurtureRule = require("../models/NurtureRule");
const WhatsAppTemplate = require("../models/WhatsAppTemplate");
const { syncTemplatesForCompany, probeTemplateEndpoints, fetchRaw } = require("../services/msg91TemplateService");
const { escapeRegex } = require("../utils/escapeRegex");

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

    res.status(201).json({ success: true, rule });
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

    res.json({ success: true, rule });
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

module.exports = { listRules, createRule, updateRule, deleteRule, syncTemplates, listTemplates, probeTemplates, rawTemplates };