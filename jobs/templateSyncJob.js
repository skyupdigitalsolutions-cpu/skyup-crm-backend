// jobs/templateSyncJob.js
// ─────────────────────────────────────────────────────────────────────────────
// Automatically keeps the local WhatsAppTemplate cache in sync with MSG91 for
// every company, on a schedule — no one has to remember to click "Sync
// Templates" or run a script by hand.
//
// WHY THIS MATTERS
// The whole nurture pipeline — real industry×service library, niche
// fallbacks, the mismatch guard, the "View" content resolver — all read from
// this local cache, not MSG91 directly (avoids hitting MSG91's API on every
// single send). If the cache goes stale, a template you just got approved in
// MSG91 keeps showing as "not found" and nurture keeps skipping it, even
// though it's perfectly sendable — purely because nobody re-synced.
//
// This job closes that gap: MSG91 approves a template → next scheduled sync
// picks it up automatically → it starts sending on its own, no manual step.
//
// SCOPE: every company that has an active WhatsAppConfig — not just
// nurture-enabled ones, since the same cache also powers manual blasts,
// outcome automation, and the send-log "View" content lookup.
//
// SCHEDULE: every hour, on the hour, UTC (matches MetaAutoSyncJob's pattern —
// template approvals aren't time-critical, hourly is more than fast enough
// and keeps MSG91 API usage light).
// ─────────────────────────────────────────────────────────────────────────────

const cron = require("node-cron");
const WhatsAppConfig = require("../models/WhatsAppConfig");
const { syncTemplatesForCompany } = require("../services/msg91TemplateService");

let isRunning = false; // overlap guard — a slow MSG91 response must never let two runs stack

async function runTemplateSync() {
  const configs = await WhatsAppConfig.find({ isActive: true }).select("company").lean();
  const companyIds = [...new Set(configs.map((c) => String(c.company)))];

  if (!companyIds.length) {
    console.log("[TemplateSyncJob] No active WhatsAppConfig found — nothing to sync.");
    return { synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;

  for (const companyId of companyIds) {
    try {
      const result = await syncTemplatesForCompany(companyId);
      console.log(
        `[TemplateSyncJob] ✅ company ${companyId}: synced ${result.total} template(s) ` +
        `(${result.nurture} industry×service/niche, ${result.other} other)`
      );
      synced++;
    } catch (err) {
      // One company's bad/missing MSG91 credentials must never block the rest.
      console.warn(`[TemplateSyncJob] ⚠️  company ${companyId} sync failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`[TemplateSyncJob] Run complete — ${synced} synced, ${failed} failed, out of ${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"}.`);
  return { synced, failed };
}

function startTemplateSyncJob() {
  cron.schedule(
    "0 * * * *",
    async () => {
      if (isRunning) {
        console.log("[TemplateSyncJob] previous run still in progress — skipping this tick");
        return;
      }
      isRunning = true;
      try {
        await runTemplateSync();
      } catch (err) {
        console.error("[TemplateSyncJob] Unhandled error:", err.message);
      } finally {
        isRunning = false;
      }
    },
    { timezone: "UTC" }
  );

  console.log("[TemplateSyncJob] 🕐 Scheduled — fires hourly to sync WhatsApp templates from MSG91 for every company.");
}

module.exports = { startTemplateSyncJob, runTemplateSync };
