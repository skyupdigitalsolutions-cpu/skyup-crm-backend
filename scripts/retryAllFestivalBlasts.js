// scripts/retryAllFestivalBlasts.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME script — re-sends EVERY past festival campaign (not just the most
// recent one) to every lead that doesn't already have a confirmed successful
// delivery, across every company. Broader version of
// retryTodayFestivalBlast.js — that one only looked at the last 24 hours;
// this one looks at every FestivalAutoBlastLog row that has ever been
// created, for every festival, for every company.
//
// SAFE BY DESIGN: retryFailedForBlastLog() re-checks two independent
// protections before ever sending anything —
//   1. Does this lead already have a successful send logged for this exact
//      campaign? (only reliable going forward now that the channel enum
//      bug is fixed — see models/WhatsAppSendLog.js)
//   2. sendAutoWhatsApp's OWN internal claim: "has this template ever been
//      delivered to this lead at all?" — this is the one that's been
//      correctly protecting people even while (1) was silently broken, and
//      it keeps working here regardless.
// So even if you run this against very old campaigns, nobody who genuinely
// already got a given festival's message will receive it twice.
//
// Usage:
//   node scripts/retryAllFestivalBlasts.js              ← dry-run, lists every campaign found
//   node scripts/retryAllFestivalBlasts.js --send       ← actually retries all of them
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");

const SEND = process.argv.includes("--send");

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`\n🎉 ALL festival campaigns retry (every campaign ever run, all companies)`);
  console.log(`   Mode: ${SEND ? "SEND (real WhatsApp/email!)" : "DRY-RUN (no send, just shows what would happen)"}\n`);

  const FestivalAutoBlastLog = require("../models/FestivalAutoBlastLog");
  const { retryFailedForBlastLog } = require("../jobs/festivalCampaignJob");

  // No date filter at all — every festival campaign log that has ever been
  // created, for any company, regardless of when it ran.
  const logs = await FestivalAutoBlastLog.find({})
    .populate("company", "name")
    .sort({ createdAt: -1 })
    .lean();

  if (logs.length === 0) {
    console.log("No festival auto-blast campaigns found at all. Nothing to retry.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${logs.length} campaign(s) across all time:\n`);
  for (const log of logs) {
    console.log(
      `  • ${log.festivalName} (${log.year}) — ${log.company?.name || log.company} — ` +
      `status: ${log.status}, sent: ${log.stats?.sent || 0}, failed: ${log.stats?.failed || 0}, skipped: ${log.stats?.skipped || 0}`
    );
  }
  console.log("");

  if (!SEND) {
    console.log("Dry-run only — nothing was sent. Re-run with --send to actually retry ALL of these.");
    await mongoose.disconnect();
    return;
  }

  let totalRetried = 0, totalSent = 0, totalFailed = 0, totalSkipped = 0;

  for (const log of logs) {
    console.log(`\n🔁 Retrying "${log.festivalName}" (${log.year}) for ${log.company?.name || log.company}...`);
    try {
      const result = await retryFailedForBlastLog(log._id);
      console.log(`   ✅ Done — retried: ${result.retried}, sent: ${result.sent}, failed: ${result.failed}, skipped: ${result.skipped}`);
      if (result.message) console.log(`   ${result.message}`);
      totalRetried += result.retried || 0;
      totalSent    += result.sent    || 0;
      totalFailed  += result.failed  || 0;
      totalSkipped += result.skipped || 0;
    } catch (err) {
      console.error(`   ❌ Retry failed for this campaign:`, err.message);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`ALL CAMPAIGNS COMPLETE`);
  console.log(`Total across ${logs.length} campaign(s): retried ${totalRetried}, sent ${totalSent}, failed ${totalFailed}, skipped ${totalSkipped}`);
  console.log(`═══════════════════════════════════════════════════\n`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
