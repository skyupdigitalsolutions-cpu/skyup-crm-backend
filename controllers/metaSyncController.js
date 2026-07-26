const { syncPageForms, reconcileMetaStatusesForCompany } = require("../services/metaSyncService");

/**
 * POST /api/meta-config/sync
 *
 * Manual "Sync from Meta" — fetches all ad sets / lead forms on a page and
 * auto-creates a MetaConfig for each. Delegates to services/metaSyncService so
 * the scheduled auto-sync job (jobs/metaAutoSyncJob.js) shares identical logic.
 * Also reconciles paused/archived status against Meta so the CRM reflects it
 * immediately (needs an ads_read token + Ad Account ID on a Meta campaign).
 */
const syncFromMeta = async (req, res) => {
  try {
    const { pageId, pageAccessToken, graphApiVersion = "v22.0" } = req.body;
    const companyId = req.admin?.company?._id || req.admin?.company;
    const adminId   = req.admin?._id || req.admin?.id || null;

    if (!pageId || !pageAccessToken) {
      return res.status(400).json({ message: "pageId and pageAccessToken are required" });
    }

    const result = await syncPageForms({ pageId, pageAccessToken, companyId, graphApiVersion, adminId });

    // Mirror Meta's paused/archived ad sets & campaigns into the CRM right away.
    let statusSync = null;
    try {
      statusSync = await reconcileMetaStatusesForCompany(companyId);
    } catch (e) {
      statusSync = { credentialed: true, reason: e.message };
    }

    res.json({ ...result, statusSync });
  } catch (err) {
    const metaError = err?.response?.data?.error?.message;
    res.status(500).json({ message: metaError || err.message });
  }
};

module.exports = { syncFromMeta };