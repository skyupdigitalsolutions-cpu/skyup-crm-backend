// controllers/festivalCampaignController.js
//
// Admin-panel CRUD for "Festival Campaigns" — WhatsApp/Email festive
// templates scheduled to auto-send to a company's leads on a specific date.
// The actual sending happens in jobs/festivalCampaignJob.js; this file only
// manages the schedule (+ a synchronous single-lead test send so an admin
// can preview what will go out before the real date arrives).

"use strict";

const FestivalCampaign = require("../models/FestivalCampaign");
const Lead             = require("../models/Leads");
const { getFestivalCatalog, getFestivalCatalogEntry } = require("../utils/festivalTemplateCatalog");
const { sendAutoWhatsApp, sendAutoEmail } = require("../services/autoTemplateService");

// ── GET /api/festival-campaigns/catalog ───────────────────────────────────────
// Read-only reference list of pre-approved festival templates + their dates,
// so the "New Campaign" form can offer a pick-list instead of free typing.
const getCatalog = async (req, res) => {
  try {
    res.json({ success: true, catalog: getFestivalCatalog() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/festival-campaigns ───────────────────────────────────────────────
const listCampaigns = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const campaigns = await FestivalCampaign.find({ company: companyId })
      .sort({ sendDate: 1 })
      .lean();
    res.json({ success: true, campaigns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/festival-campaigns/:id ───────────────────────────────────────────
const getCampaign = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const campaign = await FestivalCampaign.findOne({ _id: req.params.id, company: companyId }).lean();
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/festival-campaigns ──────────────────────────────────────────────
// Body: {
//   festivalKey?, festivalName, sendDate,
//   targetAudience?: { scope: 'all'|'byStatus', statuses?: [] },
//   channels: { whatsapp: { enabled, templateName, languageCode }, email?: {...} }
// }
const createCampaign = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const { festivalKey, festivalName, sendDate, targetAudience, channels } = req.body;

    if (!sendDate) {
      return res.status(400).json({ success: false, message: "sendDate is required" });
    }
    const parsedDate = new Date(sendDate);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: "sendDate is not a valid date" });
    }

    const wa = channels?.whatsapp || {};
    const em = channels?.email    || {};
    const waEnabled = wa.enabled !== false; // default ON for a festival blast
    const emEnabled = !!em.enabled;

    if (waEnabled && !String(wa.templateName || "").trim()) {
      return res.status(400).json({ success: false, message: "WhatsApp template name is required when the WhatsApp channel is enabled" });
    }
    if (!waEnabled && !emEnabled) {
      return res.status(400).json({ success: false, message: "Enable at least one channel (WhatsApp or Email)" });
    }

    // A catalog pick pre-fills festivalName/templateName; fully custom
    // campaigns are also allowed (festivalKey stays empty).
    const catalogEntry = festivalKey ? getFestivalCatalogEntry(festivalKey) : null;

    const campaign = await FestivalCampaign.create({
      company:      companyId,
      festivalKey:  festivalKey || "",
      festivalName: (festivalName || catalogEntry?.festivalName || "").trim() || "Festival Greeting",
      sendDate:     parsedDate,
      targetAudience: {
        scope:    targetAudience?.scope === "byStatus" ? "byStatus" : "all",
        statuses: Array.isArray(targetAudience?.statuses) ? targetAudience.statuses : [],
      },
      channels: {
        whatsapp: {
          enabled:      waEnabled,
          templateName: (wa.templateName || catalogEntry?.templateName || "").trim(),
          languageCode: wa.languageCode || "en",
        },
        email: {
          enabled:      emEnabled,
          subject:      em.subject      || "",
          fromName:     em.fromName     || "",
          bodyTemplate: em.bodyTemplate || "",
        },
      },
      createdBy: req.admin._id,
    });

    res.status(201).json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/festival-campaigns/:id ───────────────────────────────────────────
// Only campaigns that haven't started sending yet can be edited. Enable/
// disable and cancel are allowed at any time (see toggleCampaign/cancelCampaign).
const updateCampaign = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const campaign = await FestivalCampaign.findOne({ _id: req.params.id, company: companyId });
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    if (campaign.status !== "scheduled") {
      return res.status(400).json({ success: false, message: `Cannot edit a campaign that is already "${campaign.status}"` });
    }

    const { festivalName, sendDate, targetAudience, channels } = req.body;

    if (festivalName !== undefined) campaign.festivalName = String(festivalName).trim();

    if (sendDate !== undefined) {
      const parsedDate = new Date(sendDate);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ success: false, message: "sendDate is not a valid date" });
      }
      campaign.sendDate = parsedDate; // sendDateKey is recomputed by the pre-save hook
    }

    if (targetAudience !== undefined) {
      campaign.targetAudience = {
        scope:    targetAudience?.scope === "byStatus" ? "byStatus" : "all",
        statuses: Array.isArray(targetAudience?.statuses) ? targetAudience.statuses : [],
      };
    }

    if (channels?.whatsapp !== undefined) {
      const wa = channels.whatsapp;
      if (wa.enabled      !== undefined) campaign.channels.whatsapp.enabled      = !!wa.enabled;
      if (wa.templateName !== undefined) campaign.channels.whatsapp.templateName = String(wa.templateName).trim();
      if (wa.languageCode !== undefined) campaign.channels.whatsapp.languageCode = wa.languageCode;
    }
    if (channels?.email !== undefined) {
      const em = channels.email;
      if (em.enabled      !== undefined) campaign.channels.email.enabled      = !!em.enabled;
      if (em.subject      !== undefined) campaign.channels.email.subject      = em.subject;
      if (em.fromName     !== undefined) campaign.channels.email.fromName     = em.fromName;
      if (em.bodyTemplate !== undefined) campaign.channels.email.bodyTemplate = em.bodyTemplate;
    }

    if (!campaign.channels.whatsapp.enabled && !campaign.channels.email.enabled) {
      return res.status(400).json({ success: false, message: "Enable at least one channel (WhatsApp or Email)" });
    }
    if (campaign.channels.whatsapp.enabled && !campaign.channels.whatsapp.templateName) {
      return res.status(400).json({ success: false, message: "WhatsApp template name is required when the WhatsApp channel is enabled" });
    }

    await campaign.save();
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/festival-campaigns/:id/toggle ──────────────────────────────────
// Pause/resume a still-scheduled campaign without deleting it.
const toggleCampaign = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const campaign = await FestivalCampaign.findOne({ _id: req.params.id, company: companyId });
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    if (campaign.status !== "scheduled") {
      return res.status(400).json({ success: false, message: `Cannot toggle a campaign that is already "${campaign.status}"` });
    }
    campaign.enabled = req.body?.enabled !== undefined ? !!req.body.enabled : !campaign.enabled;
    await campaign.save();
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/festival-campaigns/:id ────────────────────────────────────────
const deleteCampaign = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const campaign = await FestivalCampaign.findOne({ _id: req.params.id, company: companyId });
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    if (campaign.status === "sending") {
      return res.status(400).json({ success: false, message: "Cannot delete a campaign while it is actively sending" });
    }
    await campaign.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/festival-campaigns/:id/cancel ───────────────────────────────────
const cancelCampaign = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const campaign = await FestivalCampaign.findOneAndUpdate(
      { _id: req.params.id, company: companyId, status: "scheduled" },
      { $set: { status: "cancelled" } },
      { new: true }
    );
    if (!campaign) return res.status(400).json({ success: false, message: "Only a still-scheduled campaign can be cancelled" });
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/festival-campaigns/:id/test ─────────────────────────────────────
// Sends this campaign's content to ONE real lead right now (synchronously),
// so the admin can see exactly what goes out before the scheduled date.
// Body: { leadId? } — defaults to the company's most recently created lead.
const testCampaign = async (req, res) => {
  try {
    const companyId = req.admin.company._id;
    const campaign = await FestivalCampaign.findOne({ _id: req.params.id, company: companyId }).lean();
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });

    const { leadId } = req.body || {};
    const lead = leadId
      ? await Lead.findOne({ _id: leadId, company: companyId })
      : await Lead.findOne({ company: companyId }).sort({ createdAt: -1 });

    if (!lead) return res.status(400).json({ success: false, message: "No lead found to test with" });

    const results = [];
    if (campaign.channels?.whatsapp?.enabled) {
      results.push(await sendAutoWhatsApp({ companyId, lead, whatsappSettings: campaign.channels.whatsapp }));
    }
    if (campaign.channels?.email?.enabled) {
      results.push(await sendAutoEmail({ companyId, lead, emailSettings: campaign.channels.email }));
    }

    res.json({ success: true, lead: { _id: lead._id, name: lead.name, mobile: lead.mobile, email: lead.email }, results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getCatalog,
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  toggleCampaign,
  deleteCampaign,
  cancelCampaign,
  testCampaign,
};
