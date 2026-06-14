// controllers/metaQualificationController.js
const axios             = require("axios");
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

    // Re-validate on read so the UI can surface a warning even for rule-sets
    // saved before the 100-point rule existed (auto-migration of campaigns).
    const validation = MetaQualification.validateRules(doc.rules || []);

    res.json({
      success: true,
      data: {
        ...doc,
        maxScore:     validation.maxScore,
        optionsValid: validation.valid,
      },
      validation,
    });
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

    // ── Validation: every question's options must sum to EXACTLY 100 ──────────
    // A rule-set is not allowed to be saved (and therefore not activated) unless
    // each question totals 100 points. This keeps Maximum Score = questions × 100
    // consistent across the whole system.
    const validation = MetaQualification.validateRules(rules || []);
    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        message:
          "Each question's answer options must total exactly 100 points. " +
          "Please correct the highlighted questions before activating.",
        validation,
      });
    }

    const doc = await MetaQualification.findOneAndUpdate(
      { adSetId, company: companyId },
      {
        adSetId,
        company:    companyId,
        adSetName:  adSetName  || config.adSetName  || config.campaignName,
        formId:     formId     || config.formId     || "",
        rules:      rules      || [],
        thresholds: thresholds || { hot: 80, warm: 50 },
        maxScore:     validation.maxScore,
        optionsValid: true,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );

    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * GET /api/meta-config/:adSetId/form-questions
 * Fetches question + answer options from the Meta Lead Form linked to this
 * ad set config (uses formId + pageAccessToken stored in MetaConfig).
 * Returns: { questions: [ { key, label, options: string[] } ] }
 */
const getFormQuestions = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { adSetId } = req.params;

    const config = await MetaConfig.findOne({ _id: adSetId, company: companyId });
    if (!config) {
      return res.status(404).json({ message: "Ad set config not found" });
    }

    if (!config.formId || !config.formId.trim()) {
      return res.status(400).json({
        message: "No Form ID set on this ad set. Add a Form ID in Edit to auto-load questions.",
      });
    }

    if (!config.pageAccessToken) {
      return res.status(400).json({ message: "No page access token stored for this ad set" });
    }

    const version = config.graphApiVersion || "v25.0";
    const url = `https://graph.facebook.com/${version}/${config.formId.trim()}`;

    let formData;
    try {
      const response = await axios.get(url, {
        params: {
          fields:       "questions",
          access_token: config.pageAccessToken,
        },
        timeout: 8000,
      });
      formData = response.data;
    } catch (apiErr) {
      const msg = apiErr?.response?.data?.error?.message || apiErr.message;
      return res.status(502).json({ message: `Meta API error: ${msg}` });
    }

    const rawQuestions = formData.questions || [];

    const questions = rawQuestions
      .filter((q) => q.type !== "CUSTOM_DISCLAIMER")
      .map((q) => ({
        key:     q.key,
        label:   q.label || q.key,
        type:    q.type  || "OPEN",
        options: (q.options || []).map((o) => o.value || o.key || String(o)),
      }));

    res.json({ success: true, questions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getRules, saveRules, getFormQuestions };