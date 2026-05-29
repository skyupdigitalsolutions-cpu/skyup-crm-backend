const axios = require("axios");
const MetaConfig = require("../models/MetaConfig");

/**
 * Fetches all ad sets from a Meta page and their associated lead forms,
 * then auto-creates a MetaConfig for each adset+form combination.
 *
 * Flow:
 *  1. DROP the legacy pageId_1 unique index if it still exists (migration)
 *  2. GET /{pageId}/leadgen_forms  → forms with adset_id, adset_name, campaign_name
 *  3. For forms missing adset_name, fetch /{adset_id}?fields=name,campaign_id,campaign{name}
 *  4. Upsert one MetaConfig per unique (pageId, formId)
 *
 * FIX: parentCampaignName is now always set to the Meta campaign name so that
 * the frontend can group ad-set cards under their parent campaign header.
 * campaignName is built as "CampaignName › AdSetName" so each config has a
 * unique, human-readable name while still being linkable to its parent.
 */
const syncFromMeta = async (req, res) => {
  try {
    const { pageId, pageAccessToken, graphApiVersion = "v22.0" } = req.body;
    const companyId = req.admin?.company?._id || req.admin?.company;

    if (!pageId || !pageAccessToken) {
      return res.status(400).json({ message: "pageId and pageAccessToken are required" });
    }

    // ── Step 1: Drop the legacy single-field unique index on pageId ───────────
    // The old index only allowed ONE document per pageId, which breaks multi-adset
    // support. The model now defines a compound (pageId, formId) index instead.
    try {
      const collection = MetaConfig.collection;
      const indexes = await collection.indexes();
      const legacyIndex = indexes.find(
        (idx) =>
          idx.name === "pageId_1" &&
          idx.unique === true &&
          Object.keys(idx.key).length === 1 &&
          idx.key.pageId !== undefined
      );
      if (legacyIndex) {
        await collection.dropIndex("pageId_1");
        console.log("✅ Dropped legacy pageId_1 unique index");
      }
    } catch (indexErr) {
      // Non-fatal — log and continue; index may already be gone
      console.warn("⚠️  Could not drop legacy index (may not exist):", indexErr.message);
    }

    // ── Step 2: Fetch all lead forms on the page ──────────────────────────────
    let allForms = [];
    let nextUrl = `https://graph.facebook.com/${graphApiVersion}/${pageId}/leadgen_forms`;
    let params = {
      fields: "id,name,ad_id,adset_id,campaign_id,campaign_name,adset_name",
      access_token: pageAccessToken,
      limit: 100,
    };

    while (nextUrl) {
      const formsRes = await axios.get(nextUrl, { params });
      const page = formsRes.data?.data || [];
      allForms = allForms.concat(page);
      nextUrl = formsRes.data?.paging?.next || null;
      params = {};
    }

    if (allForms.length === 0) {
      return res.json({ success: true, created: 0, skipped: 0, forms: [] });
    }

    // ── Step 3: Enrich forms that are missing adset_name / campaign_name ───────
    // Meta's leadgen_forms endpoint sometimes omits campaign_name/adset_name.
    // When missing, we fetch the ad set directly to get the campaign name —
    // this is critical because parentCampaignName depends on campaign_name.
    const enrichedForms = await Promise.all(
      allForms.map(async (form) => {
        if (form.adset_name && form.campaign_name) return form;

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
              adset_name:    form.adset_name    || adset.name           || "",
              campaign_name: form.campaign_name || adset.campaign?.name || "",
              campaign_id:   form.campaign_id   || adset.campaign?.id   || adset.campaign_id || "",
            };
          } catch {
            return form;
          }
        }
        return form;
      })
    );

    // ── Step 4: Upsert MetaConfig per (pageId, formId) ─────────────────────────
    let created = 0;
    let skipped = 0;
    const results = [];

    for (const form of enrichedForms) {
      const existing = await MetaConfig.findOne({ pageId, formId: form.id });

      // FIX: Derive parentCampaignName and adSetName first so we can use them
      // in both the "skipped" result and the "created" document consistently.
      const parentCampaignName = (form.campaign_name || "").trim();
      const adSetName          = (form.adset_name    || "").trim();

      // Build a unique, human-readable campaignName:
      //   • Both present → "CampaignName › AdSetName"   (groups + labels correctly)
      //   • Only campaign → use campaign name as-is
      //   • Neither       → fall back to the form name
      let campaignName;
      if (parentCampaignName && adSetName) {
        campaignName = `${parentCampaignName} › ${adSetName}`;
      } else if (parentCampaignName) {
        campaignName = parentCampaignName;
      } else {
        campaignName = form.name || "Meta Campaign";
      }

      if (existing) {
        // FIX: also update parentCampaignName / adSetName on skipped records
        // so that re-syncing fixes previously broken grouping data.
        if (!existing.parentCampaignName && parentCampaignName) {
          await MetaConfig.findByIdAndUpdate(existing._id, {
            parentCampaignName,
            adSetName: existing.adSetName || adSetName,
          });
          console.log(`🔄 Updated parentCampaignName for existing config: "${existing.campaignName}"`);
        }

        skipped++;
        results.push({
          formId:             form.id,
          formName:           form.name,
          campaignName:       existing.campaignName,
          adSetName:          existing.adSetName || adSetName,
          parentCampaignName: existing.parentCampaignName || parentCampaignName,
          status:             "skipped (already exists)",
        });
        continue;
      }

      await MetaConfig.create({
        campaignName,
        adSetName,
        parentCampaignName,   // ← Always the Meta campaign name; "" only if Meta truly has none
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
        formId:             form.id,
        formName:           form.name,
        campaignName,
        adSetName,
        parentCampaignName,
        status:             "created",
      });
    }

    res.json({ success: true, created, skipped, forms: results });
  } catch (err) {
    const metaError = err?.response?.data?.error?.message;
    res.status(500).json({ message: metaError || err.message });
  }
};

module.exports = { syncFromMeta };
