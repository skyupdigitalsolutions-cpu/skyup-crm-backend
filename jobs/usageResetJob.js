// jobs/usageResetJob.js — NEW FILE
// Cron job: runs at 00:01 UTC on the 1st of every month.
// Creates a fresh CompanyUsage document for the new month for every
// active company. Does NOT touch demo credits (stored as free addons).

const cron         = require("node-cron");
const Company      = require("../models/Company");
const CompanyUsage = require("../models/CompanyUsage");

// ── Core reset function (exported for manual / test invocation) ───────────────
const runUsageReset = async () => {
  const now   = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  console.log(`[UsageResetJob] 🔄 Resetting usage for month: ${month}`);

  // Get all companies (active or not — we want a clean slate for everyone)
  const companies = await Company.find({}).select("_id").lean();

  let created = 0;
  let skipped = 0;

  for (const company of companies) {
    try {
      // upsert: create if not exists, skip if already exists for this month
      // (safe to run multiple times)
      const result = await CompanyUsage.findOneAndUpdate(
        { companyId: company._id, month },
        {
          $setOnInsert: {
            companyId:          company._id,
            month,
            recordingsUsed:     0,
            transcriptionsUsed: 0,
            summariesUsed:      0,
            voiceBotUsed:       0,
          },
        },
        { upsert: true, new: false } // new: false → returns OLD doc (null if just created)
      );

      if (result === null) {
        // null means the doc was newly inserted (upserted)
        created++;
      } else {
        skipped++;
      }
    } catch (err) {
      // Duplicate key is harmless — means record already existed
      if (err.code === 11000) {
        skipped++;
      } else {
        console.error(`[UsageResetJob] ✗ Error for company ${company._id}:`, err.message);
      }
    }
  }

  console.log(
    `[UsageResetJob] ✅ Done — created ${created} new usage doc(s), skipped ${skipped} existing for ${month}`
  );
};

// ── Register monthly cron ─────────────────────────────────────────────────────
// Cron format: "minute hour day-of-month month weekday"
// "1 0 1 * *" = 00:01 UTC on the 1st of every month
const startUsageResetJob = () => {
  cron.schedule("1 0 1 * *", async () => {
    console.log("[UsageResetJob] 🗓  Monthly usage reset triggered…");
    try {
      await runUsageReset();
    } catch (err) {
      console.error("[UsageResetJob] Unhandled error:", err.message);
    }
  }, { timezone: "UTC" });

  console.log("[UsageResetJob] 🕐 Scheduled — fires at 00:01 UTC on the 1st of every month");
};

module.exports = { startUsageResetJob, runUsageReset };
