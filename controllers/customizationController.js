// controllers/customizationController.js
// ─────────────────────────────────────────────────────────────────────────────
// HTTP surface for per-company customization.
//
// Company routes (mounted at /api/customization) — READ ONLY:
//   GET    /                          any signed-in user of the company (web + mobile)
//   GET    /meta                      editor metadata (catalog, palette, enums)
//
// Developer routes (mounted under /api/developer/companies/:id/customization):
//   GET / · GET /history · GET /automations · PUT /:section · POST /:section/reset
//   PUT /automations/...  — see routes/developerRoutes.js.
//
// Editing is DEVELOPER-ONLY. Company super admins / admins / employees can
// only read the resulting configuration.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const Company = require("../models/Company");
const svc = require("../services/customizationService");
const { sanitizeEmailHtml } = require("../utils/sanitizeHtml");

function companyIdFrom(req) {
  return (
    req.params.companyId ||
    req.admin?.company?._id || req.admin?.company ||
    req.user?.companyId || req.user?.company?._id || req.user?.company ||
    req.callerCompany || null
  );
}

function callerRole(req) {
  if (req.user?.role === "developer") return "developer";
  return req.admin?.role || req.user?.role || "user";
}

function actor(req) {
  return {
    id:   req.admin?._id || req.user?._id || req.user?.userId || null,
    role: callerRole(req),
    name: req.admin?.name || req.user?.name || "",
  };
}

// Only the platform developer may change a company's customization.
// eslint-disable-next-line no-unused-vars
async function canEdit(req, _companyId) {
  return callerRole(req) === "developer";
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error("[customization]", err);
  return res.status(status).json({ success: false, message: err.message || "Customization error", field: err.field || null });
}

function meta() {
  return {
    sections: svc.SECTIONS,
    modules: svc.MODULE_CATALOG,
    palette: svc.PALETTE,
    statusCategories: svc.STATUS_CATEGORIES,
    outcomeBehaviours: svc.OUTCOME_BEHAVIOURS,
    followUpRules: svc.FOLLOWUP_RULES,
    outcomeGroups: svc.OUTCOME_GROUPS,
    customFieldTypes: svc.CUSTOM_FIELD_TYPES,
    defaults: svc.buildDefaults(),
  };
}

// GET /api/customization
const getMine = async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!companyId) return res.status(400).json({ success: false, message: "No company context." });
    const cust = await svc.getCustomization(companyId);
    const role = callerRole(req);
    const isEmployee = role === "user" || role === "employee";
    // Employees don't need admin-only knobs; everything else is non-secret config.
    const payload = isEmployee
      ? { ...cust, permissions: { employee: cust.permissions.employee, teamLead: cust.permissions.teamLead, recordings: cust.permissions.recordings }, customFields: cust.customFields.filter((f) => f.employeeVisible) }
      : cust;
    return res.json({
      success: true,
      customization: payload,
      canEdit: isEmployee ? false : await canEdit(req, companyId),
      ...(req.query.meta === "1" ? { meta: meta() } : {}),
    });
  } catch (err) {
    return sendError(res, err);
  }
};

// GET /api/customization/meta
const getMeta = async (_req, res) => res.json({ success: true, meta: meta() });

// GET /api/customization/history
const getHistory = async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!(await canEdit(req, companyId))) return res.status(403).json({ success: false, message: "Not allowed." });
    return res.json({ success: true, history: await svc.getHistory(companyId) });
  } catch (err) {
    return sendError(res, err);
  }
};

// PUT /api/customization/:section   body: { value }
const saveSection = async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!companyId) return res.status(400).json({ success: false, message: "No company context." });
    if (!(await canEdit(req, companyId))) {
      return res.status(403).json({ success: false, message: "CRM customization can only be changed from the developer panel." });
    }
    const { section } = req.params;
    const value = req.body && Object.prototype.hasOwnProperty.call(req.body, "value") ? req.body.value : req.body;
    const cust = await svc.updateSection(companyId, section, value, actor(req));
    emitUpdated(companyId, section);
    return res.json({ success: true, customization: cust });
  } catch (err) {
    return sendError(res, err);
  }
};

// POST /api/customization/:section/reset   (section may be "all")
const resetSection = async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!(await canEdit(req, companyId))) return res.status(403).json({ success: false, message: "Not allowed." });
    const cust = await svc.resetSection(companyId, req.params.section, actor(req));
    emitUpdated(companyId, req.params.section);
    return res.json({ success: true, customization: cust });
  } catch (err) {
    return sendError(res, err);
  }
};

// GET /api/customization/automations
// The outcome WhatsApp/Email templates and the follow-up reminder that
// already existed on the Company document (previously backend-only, no UI).
const getAutomations = async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!(await canEdit(req, companyId))) return res.status(403).json({ success: false, message: "Not allowed." });
    // Hydrated doc so schema defaults materialise for older company records.
    const doc = await Company.findById(companyId).select("outcomeAutomation followUpReminder name");
    if (!doc) return res.status(404).json({ success: false, message: "Company not found." });
    const c = doc.toObject();
    return res.json({ success: true, outcomeAutomation: c.outcomeAutomation || {}, followUpReminder: c.followUpReminder || {} });
  } catch (err) {
    return sendError(res, err);
  }
};

function cleanChannelBlock(src, defaults) {
  const wa = src?.whatsapp || {};
  const em = src?.email || {};
  return {
    whatsapp: {
      enabled: typeof wa.enabled === "boolean" ? wa.enabled : !!defaults?.whatsapp?.enabled,
      templateName: String(wa.templateName ?? defaults?.whatsapp?.templateName ?? "").trim().slice(0, 120),
      languageCode: String(wa.languageCode ?? defaults?.whatsapp?.languageCode ?? "en").trim().slice(0, 10) || "en",
    },
    email: {
      enabled: typeof em.enabled === "boolean" ? em.enabled : !!defaults?.email?.enabled,
      subject: String(em.subject ?? defaults?.email?.subject ?? "").slice(0, 300),
      fromName: String(em.fromName ?? defaults?.email?.fromName ?? "").slice(0, 120),
      bodyTemplate: sanitizeEmailHtml(String(em.bodyTemplate ?? defaults?.email?.bodyTemplate ?? "").slice(0, 20000)) || "",
    },
  };
}

// PUT /api/customization/automations/follow-up-reminder
const saveFollowUpReminder = async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!(await canEdit(req, companyId))) return res.status(403).json({ success: false, message: "Not allowed." });
    const doc = await Company.findById(companyId).select("followUpReminder");
    if (!doc) return res.status(404).json({ success: false, message: "Company not found." });
    const cur = doc.toObject().followUpReminder || {};
    doc.followUpReminder = cleanChannelBlock(req.body?.value || req.body, cur);
    doc.markModified("followUpReminder");
    await doc.save();
    return res.json({ success: true, followUpReminder: doc.toObject().followUpReminder });
  } catch (err) {
    return sendError(res, err);
  }
};

// PUT /api/customization/automations/outcome/:key — edit one built-in Company.outcomeAutomation entry
const saveOutcomeAutomation = async (req, res) => {
  try {
    const companyId = companyIdFrom(req);
    if (!(await canEdit(req, companyId))) return res.status(403).json({ success: false, message: "Not allowed." });
    const key = String(req.params.key || "");
    const doc = await Company.findById(companyId).select("outcomeAutomation");
    if (!doc) return res.status(404).json({ success: false, message: "Company not found." });
    const all = doc.toObject().outcomeAutomation || {};
    if (!Object.prototype.hasOwnProperty.call(all, key)) {
      return res.status(400).json({ success: false, message: `Unknown built-in automation "${key}".` });
    }
    doc.set(`outcomeAutomation.${key}`, cleanChannelBlock(req.body?.value || req.body, all[key]));
    await doc.save();
    return res.json({ success: true, outcomeAutomation: doc.toObject().outcomeAutomation });
  } catch (err) {
    return sendError(res, err);
  }
};

// Live-push so open browsers/apps reload their customization immediately.
function emitUpdated(companyId, section) {
  try {
    const io = global._io;
    if (!io) return;
    const payload = { companyId: String(companyId), section, at: new Date().toISOString() };
    io.to(`company_admin:${String(companyId)}`).emit("customization_updated", payload);
    io.to(`wa_company_${String(companyId)}`).emit("customization_updated", payload);
  } catch (_) { /* best effort */ }
}

module.exports = {
  getMine,
  getMeta,
  getHistory,
  saveSection,
  resetSection,
  getAutomations,
  saveFollowUpReminder,
  saveOutcomeAutomation,
};
