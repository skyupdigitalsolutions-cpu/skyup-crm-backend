// scripts/encryptExistingFields.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION: encrypts all plaintext sensitive fields already in MongoDB.
//
// Run ONCE after deploying the updated models with FIELD_ENCRYPTION_KEY set.
// Safe to run multiple times — already-encrypted values (starting "v1:") are
// skipped. Dry-run by default; pass --apply to actually write.
//
// Usage:
//   node scripts/encryptExistingFields.js              ← dry-run (see what would change)
//   node scripts/encryptExistingFields.js --apply      ← encrypt all plaintext values
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");
const { encrypt } = require("../utils/fieldCrypto");

const APPLY = process.argv.includes("--apply");

const TARGETS = [
  {
    modelPath: "../models/MetaConfig",
    fields: ["pageAccessToken", "appSecret", "verifyToken", "capiAccessToken"],
  },
  {
    modelPath: "../models/WhatsAppConfig",
    fields: ["msg91AuthKey", "accessToken", "verifyToken"],
  },
  {
    modelPath: "../models/SmsConfig",
    fields: ["msg91AuthKey"],
  },
  {
    modelPath: "../models/GoogleAdsConfig",
    fields: ["googleKey"],
  },
  {
    modelPath: "../models/Company",
    fields: ["brevoApiKey", "msg91EmailApiKey", "razorpayTokenId"],
    // razorpayTokenId has select:false — must be explicitly selected
    selectExtra: "+razorpayTokenId +brevoApiKey +msg91EmailApiKey",
  },
  {
    modelPath: "../models/GoogleAdsApiConfig",
    fields: ["oauthClientSecret", "developerToken", "refreshToken", "accessToken"],
  },
  {
    modelPath: "../models/GoogleAnalyticsConfig",
    fields: ["oauthClientSecret", "refreshToken", "accessToken"],
  },
];

async function migrateCollection({ modelPath, fields, selectExtra }) {
  const Model   = require(modelPath);
  const select  = fields.concat(selectExtra ? selectExtra.split(" ") : []).join(" ");
  const docs    = await Model.find({}).select(select).lean();
  let updated   = 0, skipped = 0;

  for (const doc of docs) {
    const setFields = {};
    for (const field of fields) {
      const val = doc[field];
      if (!val || typeof val !== "string") continue;
      if (val.startsWith("v1:")) { skipped++; continue; } // already encrypted
      setFields[field] = encrypt(val);
    }
    if (Object.keys(setFields).length === 0) continue;
    if (APPLY) {
      await Model.collection.updateOne({ _id: doc._id }, { $set: setFields });
    }
    updated++;
    console.log(`  ${APPLY ? "✅" : "🔍"} ${Model.modelName} ${doc._id}: would encrypt [${Object.keys(setFields).join(", ")}]`);
  }
  return { updated, skipped, total: docs.length };
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    console.error("❌ FIELD_ENCRYPTION_KEY not set — cannot encrypt. Set it first.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`\n🔐 Sensitive field encryption migration`);
  console.log(`   Mode: ${APPLY ? "APPLY (will write to DB)" : "DRY-RUN (no writes)"}\n`);

  let totalUpdated = 0;
  for (const target of TARGETS) {
    const name = target.modelPath.split("/").pop();
    process.stdout.write(`▶ ${name}... `);
    try {
      const { updated, skipped, total } = await migrateCollection(target);
      console.log(`${total} docs — ${updated} to encrypt, ${skipped} already encrypted`);
      totalUpdated += updated;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  console.log(`\n── Summary ──────────────────────────────────`);
  console.log(`  Documents to update: ${totalUpdated}`);
  if (!APPLY && totalUpdated > 0) {
    console.log(`\n  ℹ  Re-run with --apply to encrypt them:\n  node scripts/encryptExistingFields.js --apply`);
  } else if (APPLY) {
    console.log(`\n  ✅ All plaintext values have been encrypted.`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error("❌", e.message); process.exit(1); });