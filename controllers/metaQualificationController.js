// controllers/metaQualificationController.js
//
// Handles:
//   GET  /api/meta-qualification/:adSetId          — fetch saved rules
//   POST /api/meta-qualification/:adSetId          — save/upsert rules
//   GET  /api/meta-config/:adSetId/form-questions  — fetch questions from Meta Graph API
//
const axios               = require("axios");
const MetaQualification   = require("../models/MetaQualification");
const MetaConfig          = require("../models/MetaConfig");
const Lead                = require("../models/Leads");

// ─── GET /api/meta-qualification/:adSetId ─────────────────────────────────────
// Returns the qualification ruleset for the given MetaConfig (ad set) ID.
// Returns 404 if none saved yet (frontend shows blank form).
const getQualificationRules = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { adSetId } = req.params;

    const rules = await MetaQualification.findOne({
      adSetConfig: adSetId,
      company: companyId,
    }).lean();

    if (!rules) {
      return res.status(404).json({ success: false, message: "No qualification rules saved yet" });
    }

    res.json({ success: true, data: rules });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /api/meta-qualification/:adSetId ───────────────────────────────────
// Creates or fully replaces the qualification ruleset for this ad set.
const saveQualificationRules = async (req, res) => {
  try {
    const companyId = req.admin?.company?._id || req.admin?.company;
    const { adSetId } = req.params;
    const { rules, thresholds, adSetName, formId } = req.body;

    if (!rules || !Array.isArray(rules)) {
      return res.status(400).json({ message: "rules must be a non-empty array" });
    }

    // Verify the ad set config exists and belongs to this company
    const config = await MetaConfig.findOne({ _id: adSetId, company: companyId });
    if (!config) {
      return res.status(404).json({ message: "Ad set config not found or access denied" });
    }

    const saved = await MetaQualification.findOneAndUpdate(
      { adSetConfig: adSetId, company: companyId },
      {
        adSetConfig: adSetId,
        company:     companyId,
        adSetName:   adSetName || config.adSetName || "",
        formId:      formId    || config.formId    || "",
        rules,
        thresholds: {
          hot:  thresholds?.hot  ?? 70,
          warm: thresholds?.warm ?? 40,
        },
      },
      { upsert: true, new: true, runValidators: true }
    );

    res.json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /api/meta-config/:adSetId/form-questions ───────────────────────────
// Fetches question + answer options from the Meta Lead Form linked to this
// ad set config (uses formId + pageAccessToken stored in MetaConfig).
//
// Returns: { questions: [ { key, label, options: string[] } ] }
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
      return res.status(502).json({
        message: `Meta API error: ${msg}`,
      });
    }

    // formData.questions is an array of:
    //   { key, label, type, options?: [ { key, value } ] }
    const rawQuestions = formData.questions || [];

    const questions = rawQuestions
      .filter((q) => q.type !== "CUSTOM_DISCLAIMER")   // skip legal disclaimers
      .map((q) => ({
        key:     q.key,
        label:   q.label || q.key,
        type:    q.type  || "OPEN",
        // Multiple-choice answers come as options array
        options: (q.options || []).map((o) => o.value || o.key || String(o)),
      }));

    res.json({ success: true, questions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getQualificationRules, saveQualificationRules, getFormQuestions };
