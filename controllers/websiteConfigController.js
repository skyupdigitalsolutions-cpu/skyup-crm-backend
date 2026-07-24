const WebsiteConfig = require("../models/WebsiteConfig");
const { getAdminConfigScope, resolveAdminId } = require("../utils/adminLeadScope");

const getConfigs = async (req, res) => {
  try {
    const configs = await WebsiteConfig.find({ company: req.admin.company, ...getAdminConfigScope(req) });
    res.json({ data: configs });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const createConfig = async (req, res) => {
  try {
    const { sourceName, webhookSecret, pageUrl, defaultStatus, defaultRemark } = req.body;
    const config = await WebsiteConfig.create({
      sourceName, webhookSecret,
      pageUrl:       pageUrl       || "",
      defaultStatus: defaultStatus || "New",
      defaultRemark: defaultRemark || "Lead from Website",
      company:       req.admin.company,
      createdBy:     resolveAdminId(req),
    });
    res.status(201).json({ data: config });
  } catch (err) { res.status(400).json({ message: err.message }); }
};

const updateConfig = async (req, res) => {
  try {
    const { sourceName, webhookSecret, pageUrl, defaultStatus, defaultRemark } = req.body;
    const payload = { sourceName, pageUrl, defaultStatus, defaultRemark };
    if (webhookSecret && webhookSecret.trim()) payload.webhookSecret = webhookSecret.trim();

    const config = await WebsiteConfig.findOneAndUpdate(
      { _id: req.params.id, company: req.admin.company, ...getAdminConfigScope(req) },
      payload,
      { new: true }
    );
    if (!config) return res.status(404).json({ message: "Not found" });
    res.json({ data: config });
  } catch (err) { res.status(400).json({ message: err.message }); }
};

const toggleConfig = async (req, res) => {
  try {
    const config = await WebsiteConfig.findOneAndUpdate(
      { _id: req.params.id, company: req.admin.company, ...getAdminConfigScope(req) },
      [{ $set: { isActive: { $not: "$isActive" } } }],
      { new: true }
    );
    if (!config) return res.status(404).json({ message: "Not found" });
    res.json({ data: config });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const deleteConfig = async (req, res) => {
  try {
    await WebsiteConfig.findOneAndDelete({ _id: req.params.id, company: req.admin.company, ...getAdminConfigScope(req) });
    res.json({ message: "Disconnected" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// GET /api/website-config/insights?from=&to=&ai=
// Website performance report — built from CRM lead data (source "Website")
// grouped per configured source. No ad spend, so this is lead/conversion analytics.
const getInsights = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "Company not resolved" });

    const { getWebsitePerformanceReport } = require("../services/sourcePerformanceService");
    const report = await getWebsitePerformanceReport({
      company: companyId,
      from: req.query.from || null,
      to:   req.query.to   || null,
      withAI: req.query.ai !== "false",
    });
    res.json(report);
  } catch (err) { res.status(500).json({ message: err.message }); }
};


// ── Claim ownership of legacy (createdBy=null) Website configs ────────────────
const claimWebsiteConfigOwnership = async (req, res) => {
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
    const result = await WebsiteConfig.updateMany(matchQuery, { $set: { createdBy: adminId } });
    return res.json({ message: "Ownership assigned to " + targetAdmin.name, updated: result.modifiedCount });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = { getConfigs, createConfig, updateConfig, toggleConfig, deleteConfig, getInsights, claimWebsiteConfigOwnership };
