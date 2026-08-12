const MetaConfig = require("../models/MetaConfig");
const Lead       = require("../models/Leads");

// GET - All campaign connections for the admin's company (token hidden)
// BUG FIX: also returns real lead counts so the Campaigns page card shows the
// correct number instead of always "0".
const getAllConfigs = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const configs = await MetaConfig.find({ company: companyId })
      .populate("company", "name")
      .select("-pageAccessToken -adsToken -capiAccessToken")
      .lean();

    // Attach live lead counts for each campaign config.
    //
    // BUG FIX: Ad-set configs were always showing 0 leads because the count
    // query only matched `campaign: cfg.campaignName`.  When the Meta webhook
    // fires it saves the lead with `campaign` = the campaignName of whichever
    // MetaConfig *matched* the incoming formId.  For synced configs that
    // campaignName is the composite "ParentCampaign › AdSetName" string; for
    // manually-created configs it is whatever the user typed.
    //
    // To handle both cases we build a $or query that also accepts:
    //   1. The composite "parentCampaignName › adSetName" form (sync path).
    //   2. An exact adSetName match (catch-all / manual path).
    // This guarantees every config finds its own leads regardless of which
    // naming convention was used when the lead was stored.
    const enriched = await Promise.all(
      configs.map(async (cfg) => {
        // PRIMARY: leads tied to this exact ad set via metaConfigId. This is the
        // correct per-ad-set attribution — leads no longer pile onto a sibling
        // ad set that happens to share the same campaign name.
        const byConfigQuery = { company: companyId, metaConfigId: cfg._id };

        // LEGACY FALLBACK: leads created before metaConfigId existed have no
        // config reference, so match them the old way (by campaign name /
        // composite / adSetName) BUT only leads that have no metaConfigId, so we
        // never double-count a lead already attributed above.
        const campaignMatchers = [cfg.campaignName];
        if (cfg.parentCampaignName && cfg.adSetName) {
          const composite = `${cfg.parentCampaignName} › ${cfg.adSetName}`;
          if (composite !== cfg.campaignName) campaignMatchers.push(composite);
          campaignMatchers.push(cfg.adSetName);
        }
        const legacyQuery = {
          company: companyId,
          metaConfigId: null,
          campaign: campaignMatchers.length === 1 ? campaignMatchers[0] : { $in: campaignMatchers },
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

// GET - Single config by ID
const getConfigById = async (req, res) => {
  try {
    const config = await MetaConfig.findById(req.params.id)
      .populate("company", "name")
      .select("-pageAccessToken -adsToken -capiAccessToken");
    if (!config) return res.status(404).json({ message: "Config not found" });
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST - Connect a new Meta campaign
// company is always derived from the authenticated admin — never trusted from the client
const addConfig = async (req, res) => {
  try {
    const {
      campaignName,
      pageId,
      pageAccessToken,
      formIds,
      defaultStatus,
      defaultRemark,
      graphApiVersion,
      _meta,           // { META_APP_SECRET, META_VERIFY_TOKEN, META_GRAPH_API_VERSION }
    } = req.body;

    // Derive company from the JWT-authenticated admin
    const companyId = req.admin?.company?._id || req.admin?.company;

    if (!campaignName || !pageId || !pageAccessToken) {
      return res.status(400).json({
        message: "campaignName, pageId, and pageAccessToken are required",
      });
    }

    if (!companyId) {
      return res.status(400).json({
        message: "Could not determine company from session — please re-login",
      });
    }

    const formIdValue = req.body.formId?.trim() || "";

    // BUG FIX: When formId is blank (catch-all config), two ad sets on the same
    // page both have formId="" which incorrectly triggered a collision even though
    // they're different campaigns/ad sets. Now we scope the duplicate check:
    //   - formId present  → block same (pageId, formId) pair (true duplicate)
    //   - formId blank    → block same (pageId, campaignName) pair only
    let existing;
    if (formIdValue) {
      existing = await MetaConfig.findOne({ pageId, formId: formIdValue });
    } else {
      const campaignNameVal = (req.body.campaignName || "").trim();
      existing = await MetaConfig.findOne({ pageId, formId: "", campaignName: campaignNameVal });
    }
    if (existing) {
      return res.status(400).json({ message: "This Meta campaign / ad set is already connected" });
    }

    // BUG FIX: persist per-campaign appSecret & verifyToken so the webhook
    // middleware and verification handshake can use the correct credentials
    // for each page rather than always relying on the global .env values.
    const config = await MetaConfig.create({
      campaignName,
      pageId,
      pageAccessToken,
      formIds:         formIds || [],
      formId:          req.body.formId?.trim() || "",
      adSetName:       req.body.adSetName?.trim() || "",
      parentCampaignName: req.body.parentCampaignName?.trim() || "",
      category:        req.body.category?.trim() || "",
      company:         companyId,
      createdBy:       req.admin._id || req.admin.id || null,
      roundRobinIndex: 0,
      defaultStatus:   defaultStatus || "New",
      defaultRemark:   defaultRemark || "Lead from Meta Campaign",
      graphApiVersion: graphApiVersion || (_meta?.META_GRAPH_API_VERSION) || "v25.0",
      appSecret:       _meta?.META_APP_SECRET  || "",
      verifyToken:     _meta?.META_VERIFY_TOKEN || "",
      // Ad performance (Insights API) — optional, paste from Meta Business Mgr.
      adAccountId:     req.body.adAccountId?.trim()    || "",
      adsToken:        req.body.adsToken?.trim()       || "",
      metaAdsetId:     req.body.metaAdsetId?.trim()    || "",
      metaCampaignId:  req.body.metaCampaignId?.trim() || "",
      // Conversions API send-back credentials (optional — see MetaConfig.js)
      pixelId:         req.body.pixelId?.trim()         || "",
      capiAccessToken: req.body.capiAccessToken?.trim() || "",
    });

    res.status(201).json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT - Update a campaign config
const updateConfig = async (req, res) => {
  try {
    // Prevent accidental overwrite of round-robin pointer via PUT
    delete req.body.roundRobinIndex;
    // Prevent changing company via PUT
    delete req.body.company;

    const updated = await MetaConfig.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate("company", "name");

    if (!updated) return res.status(404).json({ message: "Config not found" });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH - Toggle active/inactive
const toggleConfig = async (req, res) => {
  try {
    const config = await MetaConfig.findById(req.params.id);
    if (!config) return res.status(404).json({ message: "Config not found" });
    config.isActive = !config.isActive;
    // This is an explicit admin action — clear the Meta-driven pause flag so the
    // auto-sync job treats the new state as the admin's intent and won't override
    // it. (If the ad set is still paused on Meta, the next sync will re-pause it.)
    config.pausedByMeta = false;
    await config.save();
    res.json({
      success: true,
      message: `Campaign ${config.isActive ? "activated" : "deactivated"}`,
      isActive: config.isActive,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE - Disconnect a campaign
const deleteConfig = async (req, res) => {
  try {
    const config = await MetaConfig.findByIdAndDelete(req.params.id);
    if (!config) return res.status(404).json({ message: "Config not found" });
    res.json({ success: true, message: "Campaign disconnected successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/meta-config/insights?from=&to=
// Ad performance report (spend, CPM, CPC, CTR, reach) + cost-per-lead + setup
// issue detection, per campaign/ad set, for the admin's company.
const getAdLevelInsights = async (req, res) => {
  try {
    const companyId = req.admin && req.admin.company ? (req.admin.company._id || req.admin.company) : null;
    if (!companyId) return res.status(400).json({ message: "Company not resolved" });
    const { getMetaAdLevelReport } = require("../services/metaInsightsService");
    const report = await getMetaAdLevelReport({
      company: companyId,
      from: req.query.from || null,
      to:   req.query.to   || null,
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getInsights = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    if (!companyId) return res.status(400).json({ message: "Company not resolved" });

    const { getMetaInsightsReport } = require("../services/metaInsightsService");
    const report = await getMetaInsightsReport({
      company: companyId,
      from: req.query.from || null,
      to:   req.query.to   || null,
      withAI: req.query.ai !== "false",
    });
    res.json(report);
  } catch (err) {
    // Was previously swallowed with NO server-side log — a 500 here left no
    // trace anywhere except the generic message in the browser. Log the full
    // stack so the next occurrence is traceable from EB/CloudWatch logs.
    console.error("[Meta Insights] getInsights error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── Assign / claim ownership of Meta config(s) to an admin (super admin only) ─
// Mirrors claimGoogleConfigOwnership / claimWebsiteConfigOwnership. The
// Campaigns UI posts { adminId, configId } to /meta-config/claim-ownership.
// Without this export the route handler was undefined and the server crashed
// on boot ("argument handler must be a function" at routes/metaConfig.js).
const claimMetaConfigOwnership = async (req, res) => {
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
    const result = await MetaConfig.updateMany(matchQuery, { $set: { createdBy: adminId } });
    return res.json({ message: "Ownership assigned to " + targetAdmin.name, updated: result.modifiedCount });
  } catch (err) { return res.status(500).json({ message: err.message }); }
};

module.exports = {
  getAllConfigs,
  claimMetaConfigOwnership,
  getConfigById,
  addConfig,
  updateConfig,
  toggleConfig,
  deleteConfig,
  getInsights,
  getAdLevelInsights,
};
