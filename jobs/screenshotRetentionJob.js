// jobs/screenshotRetentionJob.js — NEW FILE
// Hourly: delete WhatsApp screenshot images older than 7 days (keeping the extracted chat and
// analysis) for companies with "Auto WhatsApp Screenshot AI" on. See services/screenshotRetentionService.js.
"use strict";

const cron = require("node-cron");
const { runScreenshotRetentionSweep } = require("../services/screenshotRetentionService");

let running = false;   // never let two sweeps overlap in one process

function startScreenshotRetentionJob() {
  cron.schedule("17 * * * *", async () => {
    if (running) return;
    running = true;
    try { await runScreenshotRetentionSweep(); }
    catch (e) { console.error("[screenshotRetention] sweep error:", e.message); }
    finally { running = false; }
  });
  console.log("✅ Screenshot retention job started (hourly — images deleted after 7 days)");
}

module.exports = { startScreenshotRetentionJob };
