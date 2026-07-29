// scripts/migrateEncryption.js
// ─────────────────────────────────────────────────────────────────────────────
// RE-ENCRYPT LEGACY AES-256-CBC VALUES TO AUTHENTICATED AES-256-GCM
// ISO/IEC 27001:2022 — A.8.24 Use of cryptography
//
// The old scheme derived its key with the hardcoded literal salt "salt" and
// used CBC with no integrity protection. middlewares/encryption.js can still
// READ those values, but nothing new is written in that format. This script
// rewrites historical records so legacy support can eventually be removed.
//
// SAFETY:
//   • Dry-run by default. Nothing is written unless you pass --commit.
//   • Every value is decrypted, re-encrypted, and then decrypted again and
//     compared to the original BEFORE the update is applied. A record that
//     fails verification is skipped and reported, never overwritten.
//   • Processes in batches so a large collection doesn't exhaust memory.
//
// USAGE:
//   node scripts/migrateEncryption.js                 # dry run (safe)
//   node scripts/migrateEncryption.js --commit        # apply changes
//
// PREREQUISITE: take a database backup first. This rewrites stored data.
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");

const { encryptValue, decryptValue, isLegacyFormat } = require("../middlewares/encryption");

const COMMIT = process.argv.includes("--commit");
const BATCH  = 200;

// Collections and fields that may hold encrypted values.
const TARGETS = [
  { model: "Lead", fields: ["name", "mobile", "email", "remark", "voiceBotSummary", "voiceBotTranscript"] },
];

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGO_URI is not set.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${COMMIT ? "COMMIT (will write)" : "DRY RUN (no writes)"}\n`);

  // The passphrase used to derive keys. Must match what the app uses.
  const passphrase = process.env.ENCRYPTION_KEY;
  if (!passphrase) {
    console.error("ENCRYPTION_KEY is not set — cannot decrypt legacy values.");
    process.exit(1);
  }

  let totalScanned = 0, totalLegacy = 0, totalMigrated = 0, totalFailed = 0;

  for (const { model, fields } of TARGETS) {
    let Model;
    try {
      Model = mongoose.model(model);
    } catch (_) {
      // Register by requiring the model file if it isn't loaded yet.
      require(`../models/${model === "Lead" ? "Leads" : model}`);
      Model = mongoose.model(model);
    }

    const cursor = Model.find({}).select(fields.join(" ")).lean().cursor();
    let batch = [];

    const flush = async () => {
      if (!batch.length) return;
      if (COMMIT) {
        await Model.bulkWrite(batch, { ordered: false });
      }
      batch = [];
    };

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      totalScanned++;
      const set = {};

      for (const f of fields) {
        const val = doc[f];
        if (!isLegacyFormat(val)) continue;
        totalLegacy++;

        const plain = decryptValue(val, passphrase);
        if (plain === "[ENCRYPTED]") {
          totalFailed++;
          console.warn(`  ! ${model} ${doc._id} field "${f}": could not decrypt — skipped`);
          continue;
        }

        const reEncrypted = encryptValue(plain, passphrase);

        // Verify before trusting: decrypt the new value and compare.
        if (decryptValue(reEncrypted, passphrase) !== plain) {
          totalFailed++;
          console.warn(`  ! ${model} ${doc._id} field "${f}": verification failed — skipped`);
          continue;
        }

        set[f] = reEncrypted;
        totalMigrated++;
      }

      if (Object.keys(set).length) {
        batch.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
        if (batch.length >= BATCH) await flush();
      }
    }
    await flush();
  }

  console.log("\n──────── Summary ────────");
  console.log(`Documents scanned : ${totalScanned}`);
  console.log(`Legacy values     : ${totalLegacy}`);
  console.log(`Re-encrypted      : ${totalMigrated}`);
  console.log(`Failed / skipped  : ${totalFailed}`);
  if (!COMMIT) console.log("\nDRY RUN — nothing was written. Re-run with --commit to apply.");

  await mongoose.disconnect();
  process.exit(totalFailed > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});