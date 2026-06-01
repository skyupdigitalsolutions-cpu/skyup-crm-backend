// controllers/metaQualificationController.js
const MetaQualification = require("../models/MetaQualification");
const MetaConfig        = require("../models/MetaConfig");

/**
 * GET /api/meta-qualification/:adSetId
 * Returns the saved qualification rules for an ad set (if any).
 */
const getRules = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const doc = await MetaQualification.findOne({
      adSetId: req.params.adSetId,
      company: companyId,
    }).lean();

    if (!doc) return res.status(404).json({ success: false, message: "No rules yet" });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * POST /api/meta-qualification/:adSetId
 * Upsert qualification rules for an ad set.
 * Body: { rules, thresholds, adSetName, formId }
 */
const saveRules = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { adSetId } = req.params;
    const { rules, thresholds, adSetName, formId } = req.body;

    // Confirm the adSet belongs to this company
    const config = await MetaConfig.findOne({ _id: adSetId, company: companyId });
    if (!config) {
      return res.status(404).json({ message: "Ad set not found for this company" });
    }

    const doc = await MetaQualification.findOneAndUpdate(
      { adSetId, company: companyId },
      {
        adSetId,
        company:    companyId,
        adSetName:  adSetName  || config.adSetName  || config.campaignName,
        formId:     formId     || config.formId     || "",
        rules:      rules      || [],
        thresholds: thresholds || { hot: 70, warm: 40 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getRules, saveRules };
