/**
 * scripts/retireCountStyleCreditPacks.js
 *
 * One-time, idempotent migration: retires the old count-style AI credit packs
 * and the larger combined packs from any AddonCatalog that was already seeded,
 * leaving only the single combined 100-min pack purchasable.
 *
 * WHY THIS EXISTS
 *   addonCatalogController.seedCatalogIfEmpty() only seeds the catalog ONCE
 *   (when the collection is empty). On deployments that already seeded the old
 *   packs, removing them from DEFAULT_CATALOG in code does NOT remove the rows
 *   already in the DB — they remain isPublic and purchasable. This script
 *   marks the retired rows isPublic:false + isActive:false so they disappear
 *   from the customer Upgrade page and can no longer be bought, WITHOUT
 *   deleting them (so any historical reference still resolves a name).
 *
 *   It does NOT touch CompanyAddon records — companies that already bought/were
 *   granted an old pack keep their minutes (entitlementService still has the
 *   legacy deltas). This only affects what's offered for NEW purchases.
 *
 * RETIRED TYPES
 *   transcriptions_100, transcriptions_500, summaries_100, summaries_500,
 *   transcription_summary_500mins, transcription_summary_1000mins
 *   (kept/sold: transcription_summary_100mins)
 *
 * USAGE
 *   Dry-run (default — writes nothing, just reports):
 *     node scripts/retireCountStyleCreditPacks.js
 *   Apply:
 *     node scripts/retireCountStyleCreditPacks.js --apply
 */

require("dotenv").config();
const mongoose = require("mongoose");

const RETIRED_TYPES = [
  "transcriptions_100",
  "transcriptions_500",
  "summaries_100",
  "summaries_500",
  "transcription_summary_500mins",
  "transcription_summary_1000mins",
];

async function main() {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) {
    console.error("❌ No Mongo connection string found (MONGO_URI / MONGODB_URI / DB_URI).");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`✅ Connected. Mode: ${apply ? "APPLY" : "DRY-RUN"}`);

  const AddonCatalog = require("../models/AddonCatalog");

  const matches = await AddonCatalog.find({
    addonType: { $in: RETIRED_TYPES },
    $or: [{ isPublic: true }, { isActive: true }],
  }).lean();

  if (matches.length === 0) {
    console.log("✓ Nothing to retire — no public/active count-style packs found.");
  } else {
    console.log(`Found ${matches.length} catalog row(s) to retire:`);
    for (const m of matches) {
      console.log(`   • ${m.addonType} ("${m.name}") — isPublic=${m.isPublic} isActive=${m.isActive}`);
    }

    if (apply) {
      const res = await AddonCatalog.updateMany(
        { addonType: { $in: RETIRED_TYPES } },
        { $set: { isPublic: false, isActive: false } },
      );
      console.log(`✅ Retired ${res.modifiedCount} catalog row(s).`);
    } else {
      console.log("\n(DRY-RUN — no changes written. Re-run with --apply to retire.)");
    }
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((e) => {
  console.error("❌ Migration failed:", e.message);
  process.exit(1);
});
