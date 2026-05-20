const axios = require("axios");
const MetaConfig = require("../models/MetaConfig");

const syncFromMeta = async (req, res) => {
  try {
    const { pageId, pageAccessToken, graphApiVersion = "v21.0" } = req.body;
    const companyId = req.admin?.company?._id || req.admin?.company;

    if (!pageId || !pageAccessToken) {
      return res.status(400).json({ message: "pageId and pageAccessToken are required" });
    }

    // Step 1: Fetch all lead forms on this page
    const formsRes = await axios.get(
      `https://graph.facebook.com/${graphApiVersion}/${pageId}/leadgen_forms`,
      {
        params: {
          fields: "id,name,ad_id,adset_id,campaign_id,campaign_name,adset_name",
          access_token: pageAccessToken,
          limit: 100,
        },
      }
    );

    const forms = formsRes.data?.data || [];
    if (forms.length === 0) {
      return res.json({ success: true, created: 0, skipped: 0, forms: [] });
    }

    let created = 0;
    let skipped = 0;
    const results = [];

    for (const form of forms) {
      // Check if a MetaConfig already exists for this pageId + formId
      const existing = await MetaConfig.findOne({ pageId, formId: form.id });
      if (existing) {
        skipped++;
        results.push({ formId: form.id, formName: form.name, status: "skipped (already exists)" });
        continue;
      }

      // Create MetaConfig for this form/ad set
      await MetaConfig.create({
        campaignName:       form.campaign_name || form.name || "Meta Campaign",
        adSetName:          form.adset_name    || "",
        parentCampaignName: form.campaign_name || "",
        pageId,
        pageAccessToken,
        formId:             form.id,
        formIds:            [form.id],
        company:            companyId,
        isActive:           true,
        defaultStatus:      "New",
        defaultRemark:      "Lead from Meta Campaign",
        graphApiVersion,
        roundRobinIndex:    0,
      });

      created++;
      results.push({
        formId:       form.id,
        formName:     form.name,
        campaignName: form.campaign_name,
        adSetName:    form.adset_name,
        status:       "created",
      });
    }

    res.json({ success: true, created, skipped, forms: results });
  } catch (err) {
    const metaError = err?.response?.data?.error?.message;
    res.status(500).json({ message: metaError || err.message });
  }
};

module.exports = { syncFromMeta };
