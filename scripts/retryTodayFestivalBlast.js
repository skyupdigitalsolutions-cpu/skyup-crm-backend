// scripts/retryTodayFestivalBlast.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME script — re-sends today's festival campaign to every lead that
// doesn't already have a confirmed successful send logged against it. Built
// specifically to recover from the localizable_params bug (already fixed in
// services/autoTemplateService.js) without needing the HTTP retry endpoint
// deployed and without needing an admin JWT — this connects to MongoDB
// directly and calls the same underlying logic the endpoint would.
//
// Finds EVERY company's FestivalAutoBlastLog row created/updated TODAY,
// regardless of company — safe to run company-wide since
// retryFailedForBlastLog() only ever re-sends to leads who don't already
// have a successful send logged, so anyone who genuinely got today's
// message the first time round is never messaged twice.
//
// Usage:
//   node scripts/retryTodayFestivalBlast.js              ← dry-run, just lists what it WOULD retry
//   node scripts/retryTodayFestivalBlast.js --send       ← actually retries
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");

const SEND = process.argv.includes("--send");

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`\n🎉 Festival campaign retry`);
  console.log(`   Mode: ${SEND ? "SEND (real WhatsApp/email!)" : "DRY-RUN (no send, just shows what would happen)"}\n`);

  const FestivalAutoBlastLog = require("../models/FestivalAutoBlastLog");
  const { retryFailedForBlastLog } = require("../jobs/festivalCampaignJob");

  // "Today" here means any log row created in the last 24h — matches how
  // the auto-blast job itself only ever creates ONE row per (company,
  // festivalKey, year), so this naturally finds exactly today's festival
  // run(s) across every company that has one, without needing to know the
  // festival's name/key in advance.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const logs = await FestivalAutoBlastLog.find({ createdAt: { $gte: since } })
    .populate("company", "name")
    .lean();

  if (logs.length === 0) {
    console.log("No festival auto-blast campaigns found in the last 24 hours. Nothing to retry.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${logs.length} campaign(s) from the last 24h:\n`);
  for (const log of logs) {
    console.log(
      `  • ${log.festivalName} — ${log.company?.name || log.company} — ` +
      `status: ${log.status}, sent: ${log.stats?.sent || 0}, failed: ${log.stats?.failed || 0}, skipped: ${log.stats?.skipped || 0}`
    );
  }
  console.log("");

  if (!SEND) {
    console.log("Dry-run only — nothing was sent. Re-run with --send to actually retry these.");
    await mongoose.disconnect();
    return;
  }

  for (const log of logs) {
    console.log(`\n🔁 Retrying "${log.festivalName}" for ${log.company?.name || log.company}...`);
    try {
      const result = await retryFailedForBlastLog(log._id);
      console.log(`   ✅ Done — retried: ${result.retried}, sent: ${result.sent}, failed: ${result.failed}, skipped: ${result.skipped}`);
      if (result.message) console.log(`   ${result.message}`);
    } catch (err) {
      console.error(`   ❌ Retry failed for this campaign:`, err.message);
    }
  }

  console.log("\nAll done.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
