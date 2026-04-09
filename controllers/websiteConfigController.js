const WebsiteConfig = require("../models/WebsiteConfig");

const getConfigs = async (req, res) => {
  try {
    const configs = await WebsiteConfig.find({ company: req.admin.company });
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
      { _id: req.params.id, company: req.admin.company },
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
      { _id: req.params.id, company: req.admin.company },
      [{ $set: { isActive: { $not: "$isActive" } } }],
      { new: true }
    );
    if (!config) return res.status(404).json({ message: "Not found" });
    res.json({ data: config });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const deleteConfig = async (req, res) => {
  try {
    await WebsiteConfig.findOneAndDelete({ _id: req.params.id, company: req.admin.company });
    res.json({ message: "Disconnected" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

module.exports = { getConfigs, createConfig, updateConfig, toggleConfig, deleteConfig };