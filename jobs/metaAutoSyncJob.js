// jobs/metaAutoSyncJob.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// Cron job: auto-syncs new Meta ad sets & lead forms into MetaConfig.
//
// WHY: Meta does NOT push an event when a new ad set / lead form is created — the
// leadgen webhook only fires on new LEADS. So to pick up newly-created ad sets &
// forms automatically (instead of an admin clicking "Sync from Meta"), this job
// periodically re-runs the same page-forms sync for every page the company has
// already connected.
//
// HOW: Each MetaConfig stores its own pageId + pageAccessToken. We gather the
// distinct (company, pageId) pairs from ACTIVE configs — using the most recently
// updated config's token per page (freshest credentials) — and run
// syncPageForms for each. New forms → new MetaConfig; existing ones are skipped
// or backfilled. One page failing (e.g. an expired token) never aborts the sweep.
//
// Cadence: every 30 minutes. New ad sets/forms appear within that window with no
// manual action. Adjust the cron expression below if you want it faster/slower.
// ─────────────────────────────────────────────────────────────────────────────

const cron        = require("node-cron");
const MetaConfig  = require("../models/MetaConfig");
const { syncPageForms, reconcileMetaStatusesForCompany } = require("../services/metaSyncService");

let isRunning = false; // guard against overlapping sweeps

// ── Core function (exported for manual / test invocation) ─────────────────────
const runMetaAutoSync = async () => {
  // Pull active configs that carry page credentials, freshest first so the most
  // recent token wins per page.
  const configs = await MetaConfig.find({
    isActive: true,
    pageId:          { $nin: [null, ""] },
    pageAccessToken: { $nin: [null, ""] },
  })
    .select("company pageId pageAccessToken graphApiVersion updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  if (configs.length === 0) return { pages: 0, created: 0 };

  // Dedupe to one entry per (company, pageId); first seen = freshest token.
  const pages = new Map();
  for (const c of configs) {
    const key = `${c.company}:${c.pageId}`;
    if (!pages.has(key)) {
      pages.set(key, {
        companyId:       c.company,
        pageId:          c.pageId,
        pageAccessToken: c.pageAccessToken,
        graphApiVersion: c.graphApiVersion || "v22.0",
      });
    }
  }

  let totalCreated = 0;
  let pagesSynced  = 0;

  for (const page of pages.values()) {
    try {
      const { created = 0, skipped = 0 } = await syncPageForms(page);
      pagesSynced++;
      totalCreated += created;
      if (created > 0) {
        console.log(`[MetaAutoSyncJob] page ${page.pageId} (company ${page.companyId}): +${created} new, ${skipped} existing`);
      }
    } catch (err) {
      // Expired token, permission error, rate limit, etc. — log and continue.
      const metaError = err?.response?.data?.error?.message || err.message;
      console.warn(`[MetaAutoSyncJob] ⚠️  page ${page.pageId} (company ${page.companyId}) skipped: ${metaError}`);
    }
  }

  if (totalCreated > 0) {
    console.log(`[MetaAutoSyncJob] ✅ Synced ${pagesSynced} page(s), created ${totalCreated} new config(s).`);
  }

  // ── Status reconcile: mirror Meta's paused/archived ad sets & campaigns ─────
  // Runs once per distinct company (status lookup is per ad account, not per page).
  const companyIds = [...new Set([...pages.values()].map((p) => String(p.companyId)))];
  let totalPaused = 0, totalReactivated = 0;
  for (const companyId of companyIds) {
    try {
      const r = await reconcileMetaStatusesForCompany(companyId);
      totalPaused += r.paused || 0;
      totalReactivated += r.reactivated || 0;
      if (!r.credentialed) {
        console.log(`[MetaAutoSyncJob] ℹ️  company ${companyId}: status not synced — ${r.reason}`);
      } else if ((r.paused || 0) + (r.reactivated || 0) > 0) {
        console.log(`[MetaAutoSyncJob] 🔁 company ${companyId}: paused ${r.paused}, reactivated ${r.reactivated} (checked ${r.checked})`);
      }
    } catch (err) {
      console.warn(`[MetaAutoSyncJob] ⚠️  status reconcile failed for company ${companyId}: ${err.message}`);
    }
  }

  return { pages: pagesSynced, created: totalCreated, paused: totalPaused, reactivated: totalReactivated };
};

// ── Register cron — every 30 minutes ──────────────────────────────────────────
const startMetaAutoSyncJob = () => {
  cron.schedule("*/30 * * * *", async () => {
    if (isRunning) {
      console.log("[MetaAutoSyncJob] previous run still in progress — skipping this tick");
      return;
    }
    isRunning = true;
    try {
      await runMetaAutoSync();
    } catch (err) {
      console.error("[MetaAutoSyncJob] Unhandled error:", err.message);
    } finally {
      isRunning = false;
    }
  }, { timezone: "UTC" });

  console.log("[MetaAutoSyncJob] 🕐 Scheduled — fires every 30 min to sync new Meta ad sets & forms");
};

module.exports = { startMetaAutoSyncJob, runMetaAutoSync };