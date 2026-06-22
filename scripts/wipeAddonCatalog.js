/**
 * scripts/wipeAddonCatalog.js
 *
 * Deletes EVERY row in the AddonCatalog collection — built-in rows, legacy
 * rows, and any duplicate/junk custom rows (e.g. the "1 extra user" / "extra
 * user" ₹0 ghosts that showed up from earlier manual testing).
 *
 * WHY THIS EXISTS
 *   The customer Upgrade page and the developer Add-on Pricing panel were
 *   showing different/duplicated cards because the AddonCatalog collection
 *   had accumulated stale and duplicate rows over time (some from the old
 *   DEFAULT_CATALOG seed, some from ad-hoc "Create Custom" testing). Wiping
 *   the collection and letting it re-seed from the current DEFAULT_CATALOG
 *   gives both pages a single, consistent source of truth again.
 *
 * SAFE BY DESIGN
 *   This ONLY deletes AddonCatalog rows (the pricing/visibility catalogue).
 *   It does NOT touch CompanyAddon records, so any addon a company already
 *   purchased or was granted keeps working exactly as before — entitlements
 *   are unaffected. It only resets what's offered for NEW purchases.
 *
 *   After the wipe, the catalog is EMPTY and isPublic:false by default for
 *   every re-seeded row — nothing goes on sale automatically. Re-open the
 *   developer Add-on Pricing panel, set prices, mark the ones you want "On
 *   sale", and Save.
 *
 * USAGE
 *   Dry-run (default — writes nothing, just reports row count):
 *     node scripts/wipeAddonCatalog.js
 *   Apply:
 *     node scripts/wipeAddonCatalog.js --apply
 */

require("dotenv").config();
const mongoose = require("mongoose");

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

  const rows = await AddonCatalog.find().lean();

  if (rows.length === 0) {
    console.log("✓ AddonCatalog is already empty — nothing to delete.");
  } else {
    console.log(`Found ${rows.length} catalog row(s):`);
    for (const r of rows) {
      console.log(`   • ${r.addonType} ("${r.name}") — price=₹${r.price} isPublic=${r.isPublic} isActive=${r.isActive}${r.custom ? " [custom]" : ""}`);
    }

    if (apply) {
      const res = await AddonCatalog.deleteMany({});
      console.log(`✅ Deleted ${res.deletedCount} catalog row(s).`);
      console.log("   The catalog is now empty. It will re-seed from DEFAULT_CATALOG the");
      console.log("   next time the developer panel or customer Upgrade page loads it.");
      console.log("   Open the developer Add-on Pricing panel to set prices and mark items");
      console.log("   \"On sale\" — nothing is publicly purchasable until you do that.");
    } else {
      console.log("\n(DRY-RUN — no changes written. Re-run with --apply to delete.)");
    }
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((e) => {
  console.error("❌ Script failed:", e.message);
  process.exit(1);
});
