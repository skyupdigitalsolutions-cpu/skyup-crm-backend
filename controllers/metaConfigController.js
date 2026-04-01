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
      .select("-pageAccessToken")
      .lean();

    // Attach live lead counts for each campaign
    const enriched = await Promise.all(
      configs.map(async (cfg) => {
        const leadCount = await Lead.countDocuments({
          company:  companyId,
          campaign: cfg.campaignName,
        });
        const convertedCount = await Lead.countDocuments({
          company:  companyId,
          campaign: cfg.campaignName,
          status:   "Converted",
        });
        return { ...cfg, leads: leadCount, converted: convertedCount };
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
      .select("-pageAccessToken");
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

    const existing = await MetaConfig.findOne({ pageId });
    if (existing) {
      return res.status(400).json({ message: "This Meta page is already connected" });
    }

    // BUG FIX: persist per-campaign appSecret & verifyToken so the webhook
    // middleware and verification handshake can use the correct credentials
    // for each page rather than always relying on the global .env values.
    const config = await MetaConfig.create({
      campaignName,
      pageId,
      pageAccessToken,
      formIds:         formIds || [],
      company:         companyId,
      roundRobinIndex: 0,
      defaultStatus:   defaultStatus || "New",
      defaultRemark:   defaultRemark || "Lead from Meta Campaign",
      graphApiVersion: graphApiVersion || (_meta?.META_GRAPH_API_VERSION) || "v25.0",
      appSecret:       _meta?.META_APP_SECRET  || "",
      verifyToken:     _meta?.META_VERIFY_TOKEN || "",
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

module.exports = {
  getAllConfigs,
  getConfigById,
  addConfig,
  updateConfig,
  toggleConfig,
  deleteConfig,
};