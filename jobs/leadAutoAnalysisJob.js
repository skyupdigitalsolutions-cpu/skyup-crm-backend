// jobs/leadAutoAnalysisJob.js — NEW FILE
// Every 5 minutes: for companies with "Auto AI Intelligence" switched on, queue the AI analysis
// of leads that were never analysed or have new activity. The existing analysis job
// (jobs/leadAIAnalysisJob.js) then runs the queue. See services/leadAutoAnalysisService.js.
"use strict";

const cron = require("node-cron");
const { runAutoAnalysisSweep } = require("../services/leadAutoAnalysisService");

let running = false;   // never let two sweeps overlap in one process

function startLeadAutoAnalysisJob() {
  cron.schedule("*/5 * * * *", async () => {
    if (running) return;
    running = true;
    try { await runAutoAnalysisSweep(); }
    catch (e) { console.error("[leadAuto] sweep error:", e.message); }
    finally { running = false; }
  });
  console.log("✅ Auto AI Intelligence job started (every 5 min)");
}

module.exports = { startLeadAutoAnalysisJob };
