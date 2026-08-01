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

module.exports = { listRules, createRule, updateRule, deleteRule };
