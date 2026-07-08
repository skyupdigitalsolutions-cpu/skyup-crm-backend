const { syncPageForms } = require("../services/metaSyncService");

/**
 * POST /api/meta-config/sync
 *
 * Manual "Sync from Meta" — fetches all ad sets / lead forms on a page and
 * auto-creates a MetaConfig for each. Delegates to services/metaSyncService so
 * the scheduled auto-sync job (jobs/metaAutoSyncJob.js) shares identical logic.
 */
const syncFromMeta = async (req, res) => {
  try {
    const { pageId, pageAccessToken, graphApiVersion = "v22.0" } = req.body;
    const companyId = req.admin?.company?._id || req.admin?.company;

    if (!pageId || !pageAccessToken) {
      return res.status(400).json({ message: "pageId and pageAccessToken are required" });
    }

    const result = await syncPageForms({ pageId, pageAccessToken, companyId, graphApiVersion });
    res.json(result);
  } catch (err) {
    const metaError = err?.response?.data?.error?.message;
    res.status(500).json({ message: metaError || err.message });
  }
};

module.exports = { syncFromMeta };