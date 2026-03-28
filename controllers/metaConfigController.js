const MetaConfig = require("../models/MetaConfig");

// GET - All campaign connections (token hidden)
const getAllConfigs = async (req, res) => {
  try {
    const configs = await MetaConfig.find()
      .populate("company", "name")
      .select("-pageAccessToken");
    res.json({ success: true, data: configs });
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
const addConfig = async (req, res) => {
  try {
    const {
      campaignName,
      pageId,
      pageAccessToken,
      formIds,
      company,       // accepts 24-char ObjectId string OR plain company name
      defaultStatus,
      defaultRemark,
    } = req.body;

    if (!campaignName || !pageId || !pageAccessToken || !company) {
      return res.status(400).json({
        message: "campaignName, pageId, pageAccessToken, and company are required",
      });
    }

    // Resolve company: ObjectId string OR name string
    let companyId = company;
    const isObjectId = /^[a-f\d]{24}$/i.test(company);
    if (!isObjectId) {
      const Company = require("../models/Company");
      const found = await Company.findOne({
        name: new RegExp(`^${company.trim()}$`, "i"),
      });
      if (!found) {
        return res.status(400).json({ message: `Company "${company}" not found` });
      }
      companyId = found._id;
    }

    const existing = await MetaConfig.findOne({ pageId });
    if (existing) {
      return res.status(400).json({ message: "This Meta page is already connected" });
    }

    const config = await MetaConfig.create({
      campaignName,
      pageId,
      pageAccessToken,
      formIds:         formIds || [],
      company:         companyId,
      roundRobinIndex: 0,                             // start at first user
      defaultStatus:   defaultStatus || "New",
      defaultRemark:   defaultRemark || "Lead from Meta Campaign",
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