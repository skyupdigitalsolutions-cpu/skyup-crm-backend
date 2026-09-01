const LinkedInConfig = require("../models/LinkedInConfig");
const Lead           = require("../models/Leads");
const { INDUSTRIES, SERVICES } = require("../utils/templateNameResolver");

// Same canonical-list validation as metaConfigController.js — single source
// of truth, not a third hardcoded copy. See that file's comment for the full
// reasoning: an unvalidated industry/service here silently dooms every lead
// from this campaign to a nurture template name that will never exist.
const VALID_INDUSTRIES = new Set(INDUSTRIES);
const VALID_SERVICES   = new Set(SERVICES);

function sanitizeNurtureTag(rawValue, validSet) {
  const trimmed = String(rawValue || "").trim();
  return trimmed && validSet.has(trimmed) ? trimmed : "";
}

// GET - all LinkedIn campaign connections for the admin's company (secrets hidden)
const getAllConfigs = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const configs = await LinkedInConfig.find({ company: companyId })
      .populate("company", "name")
      .select("-accessToken -refreshToken -webhookSecret")
      .lean();

    // Attach live lead counts — same pattern as metaConfigController.js's
    // getAllConfigs, matched via leadgenId's config reference (linkedinConfigId)
    // with a legacy fallback by campaign name for any leads created before
    // that reference field existed.
    const enriched = await Promise.all(
      configs.map(async (cfg) => {
        const byConfigQuery = { company: companyId, linkedinConfigId: cfg._id };
        const legacyQuery = {
          company: companyId,
          linkedinConfigId: null,
          campaign: cfg.campaignName,
        };

        const [cfgLeads, cfgConv, legacyLeads, legacyConv] = await Promise.all([
          Lead.countDocuments(byConfigQuery),
          Lead.countDocuments({ ...byConfigQuery, status: "Converted" }),
          Lead.countDocuments(legacyQuery),
          Lead.countDocuments({ ...legacyQuery, status: "Converted" }),
        ]);

        return {
          ...cfg,
          leads:     cfgLeads + legacyLeads,
          converted: cfgConv + legacyConv,
        };
      })
    );

    res.json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET - single config by ID
const getConfigById = async (req, res) => {
  try {
    const config = await LinkedInConfig.findById(req.params.id)
      .populate("company", "name")
      .select("-accessToken -refreshToken -webhookSecret");
    if (!config) return res.status(404).json({ message: "Config not found" });
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST - connect a new LinkedIn campaign
// company always derived from the authenticated admin — never trusted from the client
const addConfig = async (req, res) => {
  try {
    const {
      campaignName,
      organizationUrn,
      accessToken,
      webhookSecret,
      refreshToken,
      leadType,
      formUrns,
      defaultStatus,
      defaultRemark,
      tokenExpiresAt,
    } = req.body;

    const companyId = req.admin?.company?._id || req.admin?.company;

    if (!campaignName || !organizationUrn || !accessToken || !webhookSecret) {
      return res.status(400).json({
        message: "campaignName, organizationUrn, accessToken, and webhookSecret are required",
      });
    }
    if (!companyId) {
      return res.status(400).json({
        message: "Could not determine company from session — please re-login",
      });
    }

    // Duplicate check — same (organizationUrn, campaignName) pair already connected.
    const existing = await LinkedInConfig.findOne({
      organizationUrn: organizationUrn.trim(),
      campaignName: campaignName.trim(),
    });
    if (existing) {
      return res.status(400).json({ message: "This LinkedIn campaign is already connected" });
    }

    const config = await LinkedInConfig.create({
      campaignName: campaignName.trim(),
      organizationUrn: organizationUrn.trim(),
      accessToken: accessToken.trim(),
      refreshToken: (refreshToken || "").trim(),
      webhookSecret: webhookSecret.trim(),
      tokenExpiresAt: tokenExpiresAt || null,
      leadType: ["SPONSORED", "COMPANY", "EVENT"].includes(leadType) ? leadType : "SPONSORED",
      formUrns: Array.isArray(formUrns) ? formUrns.map((f) => String(f).trim()).filter(Boolean) : [],
      defaultStatus: defaultStatus || "New",
      defaultRemark: defaultRemark || "Lead from LinkedIn Campaign",
      campaignGroupName: req.body.campaignGroupName?.trim() || "",
      adCampaignName:    req.body.adCampaignName?.trim()    || "",
      category:          req.body.category?.trim()          || "",
      // Same validated whitelist as Meta — see sanitizeNurtureTag above.
      industry: sanitizeNurtureTag(req.body.industry, VALID_INDUSTRIES),
      service:  sanitizeNurtureTag(req.body.service,  VALID_SERVICES),
      company:  companyId,
      createdBy: req.admin?._id || null,
    });

    const safe = config.toObject();
    delete safe.accessToken;
    delete safe.refreshToken;
    delete safe.webhookSecret;

    res.status(201).json({ success: true, data: safe });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT - update an existing config
const updateConfig = async (req, res) => {
  try {
    // Prevent overwriting fields that must stay server-controlled via this route.
    delete req.body.roundRobinIndex;
    delete req.body.company;
    delete req.body.createdBy;

    // Same validation as addConfig — an update can just as easily introduce
    // an invalid industry/service value.
    if (req.body.industry !== undefined) {
      req.body.industry = sanitizeNurtureTag(req.body.industry, VALID_INDUSTRIES);
    }
    if (req.body.service !== undefined) {
      req.body.service = sanitizeNurtureTag(req.body.service, VALID_SERVICES);
    }
    if (req.body.leadType !== undefined && !["SPONSORED", "COMPANY", "EVENT"].includes(req.body.leadType)) {
      delete req.body.leadType;
    }

    const companyId = req.admin?.company?._id || req.admin?.company;
    const updated = await LinkedInConfig.findOneAndUpdate(
      { _id: req.params.id, company: companyId }, // company filter prevents cross-tenant edits
      { $set: req.body },
      { new: true }
    ).select("-accessToken -refreshToken -webhookSecret");

    if (!updated) return res.status(404).json({ message: "Config not found" });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH - toggle active/paused
const toggleConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const config = await LinkedInConfig.findOne({ _id: req.params.id, company: companyId });
    if (!config) return res.status(404).json({ message: "Config not found" });

    config.isActive = !config.isActive;
    await config.save();

    res.json({ success: true, data: { _id: config._id, isActive: config.isActive } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE
const deleteConfig = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const deleted = await LinkedInConfig.findOneAndDelete({ _id: req.params.id, company: companyId });
    if (!deleted) return res.status(404).json({ message: "Config not found" });
    res.json({ success: true, message: "LinkedIn campaign disconnected" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getAllConfigs,
  getConfigById,
  addConfig,
  updateConfig,
  toggleConfig,
  deleteConfig,
};
