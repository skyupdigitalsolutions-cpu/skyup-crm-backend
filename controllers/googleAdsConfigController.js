const GoogleAdsConfig = require("../models/GoogleAdsConfig");
const { getAdminConfigScope, resolveAdminId } = require("../utils/adminLeadScope");

// GET all configs for the logged-in company
const getConfigs = async (req, res) => {
  try {
    const configs = await GoogleAdsConfig.find({ company: req.admin.company, ...getAdminConfigScope(req) }).populate("createdBy", "name").lean();
    res.json({ data: configs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST — create new config
const createConfig = async (req, res) => {
  try {
    const { campaignName, googleKey, campaignId, formId, defaultStatus, defaultRemark, cost, impressions, clicks, avgDealValue } = req.body;
    const config = await GoogleAdsConfig.create({
      campaignName,
      googleKey,
      campaignId:    campaignId    || "",
      formId:        formId        || "",
      defaultStatus: defaultStatus || "New",
      defaultRemark: defaultRemark || "Lead from Google Ads",
      cost:          Number(cost)         || 0,
      impressions:   Number(impressions)  || 0,
      clicks:        Number(clicks)       || 0,
      avgDealValue:  Number(avgDealValue) || 0,
      company:       req.admin.company,
      createdBy:     resolveAdminId(req),
    });
    res.status(201).json({ data: config });
  } catch (err) { 
    res.status(400).json({ message: err.message });
  }
};

// PUT /api/google-ads-config/:id — edit a campaign (incl. ad metrics).
// Tenant-scoped: only updates a config belonging to the caller's company.
const updateConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { campaignName, campaignId, formId, defaultStatus, defaultRemark, googleKey, cost, impressions, clicks, avgDealValue } = req.body;

    const update = {};
    if (campaignName  !== undefined) update.campaignName  = campaignName;
    if (campaignId    !== undefined) update.campaignId    = campaignId;
    if (formId        !== undefined) update.formId        = formId;
    if (defaultStatus !== undefined) update.defaultStatus = defaultStatus;
    if (defaultRemark !== undefined) update.defaultRemark = defaultRemark;
    if (googleKey)                   update.googleKey     = googleKey; // only rotate when provided
    if (cost         !== undefined && cost         !== "") update.cost         = Number(cost)         || 0;
    if (impressions  !== undefined && impressions  !== "") update.impressions  = Number(impressions)  || 0;
    if (clicks       !== undefined && clicks       !== "") update.clicks       = Number(clicks)       || 0;
    if (avgDealValue !== undefined && avgDealValue !== "") update.avgDealValue = Number(avgDealValue) || 0;

    const config = await GoogleAdsConfig.findOneAndUpdate(
      { _id: req.params.id, company: companyId, ...getAdminConfigScope(req) },
      update,
      { new: true },
    );
    if (!config) return res.status(404).json({ message: "Config not found" });
    res.json({ data: config });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// PATCH toggle active/pause
const toggleConfig = async (req, res) => {
  try {
    const config = await GoogleAdsConfig.findOneAndUpdate(
      { _id: req.params.id, company: req.admin.company, ...getAdminConfigScope(req) },
      [{ $set: { isActive: { $not: "$isActive" } } }],
      { new: true }
    );
    if (!config) return res.status(404).json({ message: "Not found" });
    res.json({ data: config });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE — disconnect
const deleteConfig = async (req, res) => {
  try {
    await GoogleAdsConfig.findOneAndDelete({ _id: req.params.id, company: req.admin.company, ...getAdminConfigScope(req) });
    res.json({ message: "Disconnected" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/google-ads-config/insights?from=&to=&ai=
// Google Ads performance report — built from CRM lead data (source "Google Ads")
// grouped per campaign, joined with the manual cost field for cost-per-lead.
const getInsights = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "Company not resolved" });

    const { getGoogleAdsPerformanceReport } = require("../services/sourcePerformanceService");
    const report = await getGoogleAdsPerformanceReport({
      company: companyId,
      from: req.query.from || null,
      to:   req.query.to   || null,
      withAI: req.query.ai !== "false",
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/google-ads-config/dashboard?from=&to=&campaign=&salesperson=&status=&ai=
// Full business-performance dashboard (KPIs, campaigns, funnel, CRM sales,
// sales team, AI) built from CRM lead data + manually-entered ad metrics.
const getDashboard = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "Company not resolved" });

    const { getGoogleAdsDashboard } = require("../services/googleAdsDashboardService");
    const report = await getGoogleAdsDashboard({
      company:     companyId,
      from:        req.query.from        || null,
      to:          req.query.to          || null,
      campaign:    req.query.campaign    || null,
      salesperson: req.query.salesperson || null,
      status:      req.query.status      || null,
      withAI:      req.query.ai === "true",
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


// ── Claim ownership of legacy (createdBy=null) Google Ads configs ─────────────
const claimGoogleConfigOwnership = async (req, res) => {
  try {
    const isSuperAdmin = req.admin && (req.admin.role === "super_admin" || req.admin.role === "superadmin" || req.admin.isSuperAdmin);
    if (!isSuperAdmin) return res.status(403).json({ message: "Super admin only." });
    const { adminId, configId } = req.body;
    if (!adminId) return res.status(400).json({ message: "adminId is required." });
    const companyId = req.admin.company._id || req.admin.company;
    const Admin = require("../models/Admin");
    const targetAdmin = await Admin.findOne({ _id: adminId, company: companyId }).lean();
    if (!targetAdmin) return res.status(404).json({ message: "Admin not found in this company." });
    const matchQuery = configId
      ? { _id: configId, company: companyId }
      : { company: companyId, $or: [{ createdBy: null }, { createdBy: { $exists: false } }] };
    const result = await GoogleAdsConfig.updateMany(matchQuery, { $set: { createdBy: adminId } });
    return res.json({ message: "Ownership assigned to " + targetAdmin.name, updated: result.modifiedCount });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { getConfigs, createConfig, updateConfig, toggleConfig, deleteConfig, getInsights, getDashboard, claimGoogleConfigOwnership };
