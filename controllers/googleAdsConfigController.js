const GoogleAdsConfig = require("../models/GoogleAdsConfig");

// GET all configs for the logged-in company
const getConfigs = async (req, res) => {
  try {
    const configs = await GoogleAdsConfig.find({ company: req.admin.company });
    res.json({ data: configs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST — create new config
const createConfig = async (req, res) => {
  try {
    const { campaignName, googleKey, campaignId, formId, defaultStatus, defaultRemark } = req.body;
    const config = await GoogleAdsConfig.create({
      campaignName,
      googleKey,
      campaignId:    campaignId    || "",
      formId:        formId        || "",
      defaultStatus: defaultStatus || "New",
      defaultRemark: defaultRemark || "Lead from Google Ads",
      company:       req.admin.company,
    });
    res.status(201).json({ data: config });
  } catch (err) { 
    res.status(400).json({ message: err.message });
  }
};

// PATCH toggle active/pause
const toggleConfig = async (req, res) => {
  try {
    const config = await GoogleAdsConfig.findOneAndUpdate(
      { _id: req.params.id, company: req.admin.company },
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
    await GoogleAdsConfig.findOneAndDelete({ _id: req.params.id, company: req.admin.company });
    res.json({ message: "Disconnected" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getConfigs, createConfig, toggleConfig, deleteConfig };