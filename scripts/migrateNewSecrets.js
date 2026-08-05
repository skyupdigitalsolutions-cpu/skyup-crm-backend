// scripts/migrateNewSecrets.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION for the newly-encrypted sensitive fields:
//   • MetaConfig.adsToken                    → encrypt
//   • Company.cloudinaryConfig.apiKey        → encrypt (nested)
//   • Company.cloudinaryConfig.apiSecret     → encrypt (nested)
//   • WebsiteConfig.webhookSecret            → encrypt  + set webhookSecretHash
//   • WebsiteConfig.previousSecrets[]        → set previousSecretHashes[], then clear
//
// Reads RAW documents straight from the driver (bypassing Mongoose hooks), so
// it never double-encrypts and is safe to run repeatedly. Dry-run by default.
//
// Run AFTER deploying the updated models with FIELD_ENCRYPTION_KEY set:
//   node scripts/migrateNewSecrets.js            ← dry-run (shows what would change)
//   node scripts/migrateNewSecrets.js --apply    ← write the changes
//
// After --apply succeeds, drop the now-obsolete unique index in Atlas:
//   db.websiteconfigs.dropIndex("webhookSecret_1")
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");
const { encrypt, hmac } = require("../utils/fieldCrypto");

const APPLY = process.argv.includes("--apply");
const ENC = "v1:";
const isEnc = (v) => typeof v === "string" && v.startsWith(ENC);

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    console.error("❌ FIELD_ENCRYPTION_KEY not set — cannot encrypt/hash. Set it first.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`\n🔐 New-secret migration — Mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

  let totalChanged = 0;

  // ── MetaConfig.adsToken ────────────────────────────────────────────────────
  {
    const col = db.collection("metaconfigs");
    const docs = await col.find({ adsToken: { $nin: [null, ""] } }).toArray();
    let n = 0;
    for (const d of docs) {
      if (isEnc(d.adsToken)) continue;
      n++; totalChanged++;
      console.log(`  ${APPLY ? "✅" : "🔍"} MetaConfig ${d._id}: encrypt adsToken`);
      if (APPLY) await col.updateOne({ _id: d._id }, { $set: { adsToken: encrypt(d.adsToken) } });
    }
    console.log(`   MetaConfig.adsToken: ${n} to encrypt (of ${docs.length})\n`);
  }

  // ── Company.cloudinaryConfig.apiKey / apiSecret (nested) ────────────────────
  {
    const col = db.collection("companies");
    const docs = await col.find({
      $or: [
        { "cloudinaryConfig.apiKey":    { $nin: [null, ""] } },
        { "cloudinaryConfig.apiSecret": { $nin: [null, ""] } },
      ],
    }).toArray();
    let n = 0;
    for (const d of docs) {
      const cc = d.cloudinaryConfig || {};
      const set = {};
      if (cc.apiKey    && !isEnc(cc.apiKey))    set["cloudinaryConfig.apiKey"]    = encrypt(cc.apiKey);
      if (cc.apiSecret && !isEnc(cc.apiSecret)) set["cloudinaryConfig.apiSecret"] = encrypt(cc.apiSecret);
      if (!Object.keys(set).length) continue;
      n++; totalChanged++;
      console.log(`  ${APPLY ? "✅" : "🔍"} Company ${d._id}: encrypt [${Object.keys(set).join(", ")}]`);
      if (APPLY) await col.updateOne({ _id: d._id }, { $set: set });
    }
    console.log(`   Company.cloudinaryConfig: ${n} to encrypt (of ${docs.length})\n`);
  }

  // ── WebsiteConfig.webhookSecret + hashes ────────────────────────────────────
  {
    const col = db.collection("websiteconfigs");
    const docs = await col.find({}).toArray();
    let n = 0;
    for (const d of docs) {
      const set = {};

      // webhookSecret: hash needs the PLAINTEXT. If already encrypted we can't
      // recover it here, so we only (re)hash when it's still plaintext — which
      // is exactly the pre-migration state. Encrypted rows already have a hash.
      if (d.webhookSecret && !isEnc(d.webhookSecret)) {
        set.webhookSecretHash = hmac(d.webhookSecret);
        set.webhookSecret     = encrypt(d.webhookSecret);
      } else if (d.webhookSecret && isEnc(d.webhookSecret) && !d.webhookSecretHash) {
        console.warn(`  ⚠️  WebsiteConfig ${d._id}: webhookSecret already encrypted but no hash — rotate this secret to restore inbound matching.`);
      }

      // previousSecrets[] → previousSecretHashes[], then clear the plaintext.
      if (Array.isArray(d.previousSecrets) && d.previousSecrets.length &&
          !(Array.isArray(d.previousSecretHashes) && d.previousSecretHashes.length)) {
        set.previousSecretHashes = d.previousSecrets.filter(Boolean).map(hmac);
        set.previousSecrets      = [];
      }

      if (!Object.keys(set).length) continue;
      n++; totalChanged++;
      console.log(`  ${APPLY ? "✅" : "🔍"} WebsiteConfig ${d._id} ("${d.sourceName}"): [${Object.keys(set).join(", ")}]`);
      if (APPLY) await col.updateOne({ _id: d._id }, { $set: set });
    }
    console.log(`   WebsiteConfig: ${n} to update (of ${docs.length})\n`);
  }

  console.log(`── Summary ──────────────────────────────────`);
  console.log(`  ${APPLY ? "Wrote" : "Would change"} ${totalChanged} document(s).`);
  if (!APPLY) console.log(`  Re-run with --apply to write:\n  node scripts/migrateNewSecrets.js --apply`);
  else console.log(`  ✅ Done. Now drop the stale index:  db.websiteconfigs.dropIndex("webhookSecret_1")`);

  await mongoose.disconnect();
}

run().catch((e) => { console.error("Migration failed:", e); process.exit(1); });