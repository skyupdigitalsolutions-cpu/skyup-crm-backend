// controllers/metaQualificationController.js
const axios                  = require("axios");
const MetaQualification      = require("../models/MetaQualification");
const MetaConfig             = require("../models/MetaConfig");
const Lead                   = require("../models/Leads");
const { scoreQualification } = require("../utils/qualificationScorer");

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
 *
 * After saving, re-scores ALL leads for this ad set that have stored
 * field_data (qualificationBreakdown) so scores reflect the new rules
 * without waiting for new webhooks.
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

    // Validation: every question's options must sum to EXACTLY 100
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

    const resolvedAdSetName = adSetName || config.adSetName || config.campaignName;

    const doc = await MetaQualification.findOneAndUpdate(
      { adSetId, company: companyId },
      {
        adSetId,
        company:      companyId,
        adSetName:    resolvedAdSetName,
        formId:       formId     || config.formId || "",
        rules:        rules      || [],
        thresholds:   thresholds || { hot: 80, warm: 50 },
        maxScore:     validation.maxScore,
        optionsValid: true,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );

    // ── Re-score existing leads for this ad set (non-blocking) ───────────────
    // When rules or thresholds change, previously scored leads become stale.
    // We rebuild scores from the stored qualificationBreakdown answers so the
    // admin sees accurate scores immediately without waiting for new webhooks.
    setImmediate(async () => {
      try {
        await rescoreLeadsForAdSet(doc, resolvedAdSetName, companyId);
      } catch (e) {
        console.warn("[saveRules] Background re-score failed:", e.message);
      }
    });

    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Re-score all leads for a given ad set using the latest qualification rules.
 * Reconstructs field_data from qualificationBreakdown (stored at webhook time)
 * so we can run the scorer without calling the Meta API again.
 *
 * @param {Object} qualDoc          – saved MetaQualification document
 * @param {string} adSetName        – used to find leads by adSetName field
 * @param {string|ObjectId} companyId
 */
async function rescoreLeadsForAdSet(qualDoc, adSetName, companyId) {
  // Find leads from this ad set that have a stored breakdown
  const leads = await Lead.find({
    company: companyId,
    adSetName,
    qualificationBreakdown: { $exists: true, $not: { $size: 0 } },
  }).select(
    "qualificationBreakdown leadScore maxScore qualificationPercentage leadCategory temperature"
  ).lean();

  if (!leads.length) return;

  console.log(`[rescoreLeads] Re-scoring ${leads.length} leads for ad set "${adSetName}"…`);

  let updated = 0;
  for (const lead of leads) {
    // Reconstruct field_data from the stored breakdown. CRITICAL: the scorer
    // matches rules by questionKey, so the reconstructed `name` MUST be the
    // question KEY — not the human label. Older breakdowns saved before this fix
    // only stored the label, so fall back to mapping the label back to a rule's
    // questionKey via the qualification doc. (Using the label as `name` was the
    // bug that silently re-scored every existing lead to 0% / Cold.)
    const ruleByLabel = new Map(
      (qualDoc.rules || []).map((r) => [
        String(r.questionLabel || r.questionKey || "").trim().toLowerCase(),
        r.questionKey,
      ])
    );

    const fieldData = (lead.qualificationBreakdown || []).map((b) => {
      const key =
        b.questionKey ||
        ruleByLabel.get(String(b.question || "").trim().toLowerCase()) ||
        b.question; // last-resort fallback
      return { name: key, values: [b.answer] };
    });

    const {
      leadScore,
      maxScore,
      qualificationPercentage,
      leadCategory,
      qualificationBreakdown,
    } = scoreQualification(fieldData, qualDoc);

    // Also sync temperature to stay consistent with leadCategory
    const update = {
      leadScore,
      maxScore,
      qualificationPercentage,
      leadCategory,
      qualificationBreakdown,
    };
    if (leadCategory) update.temperature = leadCategory;

    await Lead.findByIdAndUpdate(lead._id, { $set: update });
    updated++;
  }

  console.log(`[rescoreLeads] Updated ${updated} lead(s) for "${adSetName}".`);
}

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