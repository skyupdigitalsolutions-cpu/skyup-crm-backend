// scripts/dropStaleAdSetConfigIndex.js
//
// Fixes:
//   MongoServerError: E11000 duplicate key error collection:
//   skyup-crm.metaqualifications index: adSetConfig_1 dup key: { adSetConfig: null }
//
// Why this happens:
//   The MetaQualification collection has a leftover unique index called
//   "adSetConfig_1" from an older version of the schema (the field was
//   later renamed to "adSetId"). Since no document has an "adSetConfig"
//   field anymore, MongoDB treats it as null for every document — and a
//   unique index only allows ONE null. The first insert/upsert succeeds,
//   every one after that fails with E11000.
//
//   Dropping the index is safe: the current schema already enforces
//   uniqueness correctly via `adSetId: { unique: true }`, which Mongoose
//   will (re)create automatically on next app start as "adSetId_1".
//
// Usage:
//   node scripts/dropStaleAdSetConfigIndex.js
//
// Safe to re-run — if the index is already gone it just logs that and exits.

require("dotenv").config();
const mongoose = require("mongoose");

const STALE_INDEX_NAME = "adSetConfig_1";
const COLLECTION_NAME = "metaqualifications";

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) {
    console.error("✖ No MONGO_URI / MONGODB_URI / DB_URI env var found. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("✓ Connected to MongoDB\n");

  const db = mongoose.connection.db;
  const collection = db.collection(COLLECTION_NAME);

  const indexes = await collection.indexes();
  console.log(`Current indexes on "${COLLECTION_NAME}":`);
  indexes.forEach((idx) => console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`));

  const staleIndex = indexes.find((idx) => idx.name === STALE_INDEX_NAME);

  if (!staleIndex) {
    console.log(`\n✓ No index named "${STALE_INDEX_NAME}" found. Nothing to do.`);
  } else {
    console.log(`\n⚠ Found stale index "${STALE_INDEX_NAME}". Dropping it...`);
    await collection.dropIndex(STALE_INDEX_NAME);
    console.log(`✓ Dropped index "${STALE_INDEX_NAME}".`);
  }

  // Optional cleanup: any pre-existing docs that still have a literal
  // `adSetConfig` field (from before the rename) won't match the current
  // schema and are just dead weight — strip the field if present.
  const cleanupResult = await collection.updateMany(
    { adSetConfig: { $exists: true } },
    { $unset: { adSetConfig: "" } }
  );
  if (cleanupResult.modifiedCount > 0) {
    console.log(
      `✓ Removed leftover "adSetConfig" field from ${cleanupResult.modifiedCount} document(s).`
    );
  }

  console.log(
    "\nDone. Restart the app — Mongoose will ensure the correct unique index on " +
      '"adSetId" (named adSetId_1) automatically.'
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});