const axios = require("axios");
const MetaConfig = require("../models/MetaConfig");

/**
 * Fetches all ad sets from a Meta page and their associated lead forms,
 * then auto-creates a MetaConfig for each adset+form combination.
 *
 * Flow:
 *  1. GET /{pageId}/leadgen_forms  → forms with adset_id, adset_name, campaign_name
 *  2. For forms missing adset_name, fetch /{adset_id}?fields=name,campaign_id,campaign{name}
 *  3. Upsert one MetaConfig per unique (pageId, formId)
 */
const syncFromMeta = async (req, res) => {
  try {
    const { pageId, pageAccessToken, graphApiVersion = "v21.0" } = req.body;
    const companyId = req.admin?.company?._id || req.admin?.company;

    if (!pageId || !pageAccessToken) {
      return res.status(400).json({ message: "pageId and pageAccessToken are required" });
    }

    // ── Step 1: Fetch all lead forms on the page ──────────────────────────────
    let allForms = [];
    let nextUrl = `https://graph.facebook.com/${graphApiVersion}/${pageId}/leadgen_forms`;
    let params = {
      fields: "id,name,ad_id,adset_id,campaign_id,campaign_name,adset_name",
      access_token: pageAccessToken,
      limit: 100,
    };

    // Paginate through all forms
    while (nextUrl) {
      const formsRes = await axios.get(nextUrl, { params });
      const page = formsRes.data?.data || [];
      allForms = allForms.concat(page);
      nextUrl = formsRes.data?.paging?.next || null;
      params = {}; // next URL already has params baked in
    }

    if (allForms.length === 0) {
      return res.json({ success: true, created: 0, skipped: 0, forms: [] });
    }

    // ── Step 2: Enrich forms that are missing adset_name / campaign_name ───────
    // Meta sometimes omits these fields if the form isn't tied to an active ad.
    const enrichedForms = await Promise.all(
      allForms.map(async (form) => {
        if (form.adset_name && form.campaign_name) return form; // already complete

        if (form.adset_id) {
          try {
            const adsetRes = await axios.get(
              `https://graph.facebook.com/${graphApiVersion}/${form.adset_id}`,
              {
                params: {
                  fields: "id,name,campaign_id,campaign{id,name}",
                  access_token: pageAccessToken,
                },
              }
            );
            const adset = adsetRes.data;
            return {
              ...form,
              adset_name:    form.adset_name    || adset.name               || "",
              campaign_name: form.campaign_name || adset.campaign?.name     || "",
              campaign_id:   form.campaign_id   || adset.campaign?.id       || adset.campaign_id || "",
            };
          } catch {
            // If ad set lookup fails (deleted / permission gap), keep what we have
            return form;
          }
        }
        return form;
      })
    );

    // ── Step 3: Upsert MetaConfig per (pageId, formId) ─────────────────────────
    let created = 0;
    let skipped = 0;
    const results = [];

    for (const form of enrichedForms) {
      const existing = await MetaConfig.findOne({ pageId, formId: form.id });
      if (existing) {
        skipped++;
        results.push({
          formId:       form.id,
          formName:     form.name,
          campaignName: form.campaign_name || form.name,
          adSetName:    form.adset_name || "",
          status:       "skipped (already exists)",
        });
        continue;
      }

      const campaignName = form.campaign_name || form.name || "Meta Campaign";
      const adSetName    = form.adset_name    || "";

      await MetaConfig.create({
        campaignName,
        adSetName,
        parentCampaignName: form.campaign_name || "",
        pageId,
        pageAccessToken,
        formId:          form.id,
        formIds:         [form.id],
        company:         companyId,
        isActive:        true,
        defaultStatus:   "New",
        defaultRemark:   "Lead from Meta Campaign",
        graphApiVersion,
        roundRobinIndex: 0,
      });

      created++;
      results.push({
        formId:       form.id,
        formName:     form.name,
        campaignName,
        adSetName,
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
