// controllers/festivalAutoBlastController.js
//
// "Flip it on once" settings for Festival Auto-Blast. Mirrors the existing
// autoTemplate / interestedBlast settings pattern (get/update on Company),
// EXCEPT there's no per-message template name to configure — the WhatsApp
// template for each festival comes straight from utils/festivalTemplateCatalog.js,
// keyed by date. Turning this on is the only manual step; every catalog
// festival then fires automatically on its date from then on.

"use strict";

const Company  = require("../models/Company");
const Lead     = require("../models/Leads");
const FestivalAutoBlastLog = require("../models/FestivalAutoBlastLog");
const { getFestivalCatalog } = require("../utils/festivalTemplateCatalog");
const { sendAutoWhatsApp, sendAutoEmail } = require("../services/autoTemplateService");
const { retryFailedForBlastLog } = require("../jobs/festivalCampaignJob");

// ── GET /api/festival-campaigns/auto-blast ────────────────────────────────────
const getSettings = async (req, res, next) => {
  try {
    const company = await Company.findById(req.admin.company._id).select("festivalAutoBlast");
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });
    res.json({ success: true, festivalAutoBlast: company.festivalAutoBlast || {}, catalog: getFestivalCatalog() });
  } catch (err) {
    next(err);
  }
};

// ── PUT /api/festival-campaigns/auto-blast ────────────────────────────────────
// Body: { enabled?, whatsapp?: {enabled, languageCode}, email?: {enabled, subject, fromName, bodyTemplate}, targetAudience?: {scope, statuses} }
const updateSettings = async (req, res, next) => {
  try {
    const { enabled, whatsapp, email, targetAudience } = req.body;
    const update = {};

    if (enabled !== undefined) update["festivalAutoBlast.enabled"] = !!enabled;

    if (whatsapp !== undefined) {
      if (typeof whatsapp.enabled === "boolean") update["festivalAutoBlast.whatsapp.enabled"] = whatsapp.enabled;
      if (whatsapp.languageCode !== undefined)   update["festivalAutoBlast.whatsapp.languageCode"] = whatsapp.languageCode;
    }
    if (email !== undefined) {
      if (typeof email.enabled === "boolean") update["festivalAutoBlast.email.enabled"]      = email.enabled;
      if (email.subject      !== undefined)   update["festivalAutoBlast.email.subject"]      = email.subject;
      if (email.fromName     !== undefined)   update["festivalAutoBlast.email.fromName"]     = email.fromName;
      if (email.bodyTemplate !== undefined)   update["festivalAutoBlast.email.bodyTemplate"] = email.bodyTemplate;
    }
    if (targetAudience !== undefined) {
      update["festivalAutoBlast.targetAudience.scope"] = targetAudience?.scope === "byStatus" ? "byStatus" : "all";
      update["festivalAutoBlast.targetAudience.statuses"] = Array.isArray(targetAudience?.statuses) ? targetAudience.statuses : [];
    }

    const company = await Company.findByIdAndUpdate(
      req.admin.company._id,
      { $set: update },
      { new: true, select: "festivalAutoBlast" }
    );
    if (!company) return res.status(404).json({ success: false, message: "Company not found" });
    res.json({ success: true, festivalAutoBlast: company.festivalAutoBlast });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/festival-campaigns/auto-blast/test ──────────────────────────────
// Synchronously sends ONE catalog festival's content to ONE real lead, so the
// admin can preview it without waiting for the actual date. Body: { festivalKey, leadId? }
const testSettings = async (req, res, next) => {
  try {
    const companyId = req.admin.company._id;
    const { festivalKey, leadId } = req.body || {};
    const entry = getFestivalCatalog().find((f) => f.key === festivalKey);
    if (!entry) return res.status(400).json({ success: false, message: "Unknown festivalKey" });

    const company = await Company.findById(companyId).select("festivalAutoBlast");
    const cfg = company?.festivalAutoBlast || {};

    const lead = leadId
      ? await Lead.findOne({ _id: leadId, company: companyId })
      : await Lead.findOne({ company: companyId }).sort({ createdAt: -1 });
    if (!lead) return res.status(400).json({ success: false, message: "No lead found to test with" });

    const results = [];
    if (cfg.whatsapp?.enabled !== false) {
      results.push(await sendAutoWhatsApp({
        companyId,
        lead,
        whatsappSettings: { templateName: entry.templateName, languageCode: cfg.whatsapp?.languageCode || "en" },
      }));
    }
    if (cfg.email?.enabled) {
      const subject      = (cfg.email.subject      || "Happy {{festival}}, {{name}}!").replace(/{{festival}}/g, entry.festivalName);
      const bodyTemplate = (cfg.email.bodyTemplate  || "").replace(/{{festival}}/g, entry.festivalName);
      results.push(await sendAutoEmail({
        companyId, lead,
        emailSettings: { subject, fromName: cfg.email.fromName || "", bodyTemplate },
      }));
    }

    res.json({ success: true, festival: entry.festivalName, lead: { _id: lead._id, name: lead.name, mobile: lead.mobile, email: lead.email }, results });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/festival-campaigns/auto-blast/history ────────────────────────────
// Lets an admin see every past auto-blast run for their company — including
// its outcome (sent/failed/skipped counts) — so a failed run (like the one
// this endpoint pair was built to recover from) is actually visible and
// actionable, not just a silent aggregate the admin has no way to inspect.
const getBlastHistory = async (req, res, next) => {
  try {
    const logs = await FestivalAutoBlastLog.find({ company: req.admin.company._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, history: logs });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/festival-campaigns/auto-blast/:logId/retry ──────────────────────
// Re-sends to every lead in this campaign's target audience who doesn't
// already have a confirmed successful send logged against it — see
// jobs/festivalCampaignJob.js's retryFailedForBlastLog for the full reasoning
// on why this is safer than trusting a stored "who failed" list.
const retryBlast = async (req, res, next) => {
  try {
    const log = await FestivalAutoBlastLog.findOne({
      _id: req.params.logId,
      company: req.admin.company._id, // company-scoped — an admin can only retry their OWN company's campaigns
    });
    if (!log) return res.status(404).json({ success: false, message: "Campaign log not found for your company." });

    const result = await retryFailedForBlastLog(log._id);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
};

module.exports = { getSettings, updateSettings, testSettings, getBlastHistory, retryBlast };
