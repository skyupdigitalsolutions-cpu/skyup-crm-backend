// jobs/screenshotAutoJob.js — NEW FILE
// Every 5 minutes: for companies with "Auto WhatsApp Screenshot AI" switched on,
// read any WhatsApp screenshots that haven't been read yet (older uploads, stuck
// or failed reads) and queue the AI analysis of leads that have new screenshot data.
// See services/screenshotAutoService.js for the rules and the cost limits.
"use strict";

const cron = require("node-cron");
const { runAutoScreenshotBatch } = require("../services/screenshotAutoService");

let running = false;   // never let two sweeps overlap in one process

function startScreenshotAutoJob() {
  cron.schedule("*/5 * * * *", async () => {
    if (running) return;
    running = true;
    try { await runAutoScreenshotBatch(); }
    catch (e) { console.error("[screenshotAuto] sweep error:", e.message); }
    finally { running = false; }
  });
  console.log("✅ Auto WhatsApp screenshot job started (every 5 min)");
}

module.exports = { startScreenshotAutoJob };
