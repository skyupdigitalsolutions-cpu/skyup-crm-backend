// services/metaStatusCron.js
// ─────────────────────────────────────────────────────────────────────────────
// Scheduled auto-sync of Meta ad-set / campaign / form status into the CRM.
//
// Until now the status mirror only ran when an admin clicked "Auto-Sync
// Campaigns from Meta". This job runs reconcileMetaStatusesForCompany() on a
// timer for every company that has at least one Meta campaign with an
// ads_read token, so cards stay in step with Meta automatically (a campaign
// paused on Meta flips to Paused in the CRM within one interval).
//
// Env (all optional):
//   META_STATUS_SYNC_DISABLED = "true"  → turn the job off
//   META_STATUS_SYNC_MINUTES  = 60      → interval in minutes (default 60)
//   META_STATUS_SYNC_BOOT_DELAY_SEC = 30 → first run delay after boot (default 30s)
//
// No optional-chaining / nullish-coalescing operators — Beautify-safe.
// ─────────────────────────────────────────────────────────────────────────────

const MetaConfig = require("../models/MetaConfig");
const { reconcileMetaStatusesForCompany } = require("./metaSyncService");

let timer = null;
let running = false;

function intervalMs() {
  const raw = process.env.META_STATUS_SYNC_MINUTES;
  const mins = raw && !isNaN(Number(raw)) ? Number(raw) : 60;
  const safe = mins > 0 ? mins : 60;
  return safe * 60 * 1000;
}

function bootDelayMs() {
  const raw = process.env.META_STATUS_SYNC_BOOT_DELAY_SEC;
  const sec = raw && !isNaN(Number(raw)) ? Number(raw) : 30;
  const safe = sec >= 0 ? sec : 30;
  return safe * 1000;
}

// Companies that actually have ads_read credentials to sync against.
async function companiesToSync() {
  try {
    const ids = await MetaConfig.distinct("company", {
      adAccountId: { $nin: ["", null] },
      adsToken:    { $nin: ["", null] },
    });
    return ids || [];
  } catch (e) {
    console.warn("[MetaStatusCron] could not list companies:", e.message);
    return [];
  }
}

async function runOnce() {
  if (running) { return; } // never overlap
  running = true;
  const started = Date.now();
  try {
    const companies = await companiesToSync();
    if (companies.length === 0) { running = false; return; }

    let totalPaused = 0, totalReactivated = 0, totalChecked = 0, ok = 0;
    for (let i = 0; i < companies.length; i++) {
      const companyId = companies[i];
      try {
        const r = await reconcileMetaStatusesForCompany(companyId);
        if (r && r.credentialed) {
          ok++;
          totalPaused      += (r.paused || 0);
          totalReactivated += (r.reactivated || 0);
          totalChecked     += (r.checked || 0);
        }
      } catch (e) {
        console.warn("[MetaStatusCron] company " + String(companyId) + " failed: " + e.message);
      }
    }
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(
      "[MetaStatusCron] synced " + ok + "/" + companies.length + " companies in " + secs + "s — " +
      "checked " + totalChecked + ", paused " + totalPaused + ", reactivated " + totalReactivated + "."
    );
  } catch (e) {
    console.warn("[MetaStatusCron] run failed:", e.message);
  } finally {
    running = false;
  }
}

// Call once at server startup.
function startMetaStatusCron() {
  if (String(process.env.META_STATUS_SYNC_DISABLED || "").toLowerCase() === "true") {
    console.log("[MetaStatusCron] disabled via META_STATUS_SYNC_DISABLED.");
    return;
  }
  if (timer) return; // already started

  const boot = bootDelayMs();
  const every = intervalMs();

  setTimeout(function () {
    runOnce();
    timer = setInterval(runOnce, every);
    if (timer && typeof timer.unref === "function") timer.unref();
  }, boot);

  console.log("[MetaStatusCron] scheduled — first run in " + Math.round(boot / 1000) + "s, then every " + Math.round(every / 60000) + " min.");
}

module.exports = { startMetaStatusCron, runMetaStatusSyncNow: runOnce };
