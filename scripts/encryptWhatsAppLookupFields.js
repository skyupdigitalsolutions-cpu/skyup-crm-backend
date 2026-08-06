// scripts/encryptWhatsAppLookupFields.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION for the two WhatsApp fields that back live equality
// lookups: WhatsAppTemplate.integratedNumber and WhatsAppConversation.waPhone.
//
// These are DIFFERENT from scripts/encryptExistingSensitiveFields.js — that
// script covered fields that are only ever displayed, never queried by value.
// These two ARE queried by value (template sync upserts, inbound WhatsApp
// message routing), so the model now also stores a deterministic HMAC
// (integratedNumberHash / waPhoneHash) alongside the encrypted value, and all
// matching queries filter on the hash instead of the encrypted field.
//
// ⚠️  DEPLOYMENT ORDER MATTERS — read before running:
//   1. Deploy the updated models/WhatsAppTemplate.js, models/WhatsAppConversation.js,
//      utils/conversationMerge.js, controllers/whatsappWebhookController.js,
//      controllers/whatsappChatController.js, services/msg91TemplateService.js.
//   2. Run this script with --apply IMMEDIATELY after deploy completes.
//   3. Until step 2 finishes, existing documents have no hash yet, so:
//        - an inbound WhatsApp message for an EXISTING lead will not match its
//          existing conversation and will create a new (duplicate) one instead
//          — the exact bug utils/conversationMerge.js exists to prevent.
//        - the next WhatsApp template sync will not match existing template
//          rows and will insert 1750+ duplicate rows instead of updating them.
//      Both are self-correcting once this script has run (old duplicate rows
//      are not auto-deleted — see the note at the bottom), but the smaller the
//      gap between deploy and running this with --apply, the better.
//
// Safe to run more than once — values already starting "v1:" are left alone,
// and the hash is recomputed (harmlessly) from the current plaintext each run
// until encryption has been applied, after which decrypt() is used to recover
// the plaintext for hash verification instead of re-hashing ciphertext.
//
// Usage:
//   node scripts/encryptWhatsAppLookupFields.js            ← dry-run (no writes)
//   node scripts/encryptWhatsAppLookupFields.js --apply    ← encrypt + backfill hashes
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");
const { encrypt, hmac } = require("../utils/fieldCrypto");

const APPLY = process.argv.includes("--apply");

const TARGETS = [
  {
    modelPath:   "../models/WhatsAppTemplate",
    field:       "integratedNumber",
    hashField:   "integratedNumberHash",
  },
  {
    modelPath:   "../models/WhatsAppConversation",
    field:       "waPhone",
    hashField:   "waPhoneHash",
  },
];

async function migrateCollection({ modelPath, field, hashField }) {
  const Model = require(modelPath);
  const projection = { _id: 1, [field]: 1, [hashField]: 1 };

  const cursor = Model.collection.find({}, { projection });
  let updated = 0, skipped = 0, total = 0;

  for await (const doc of cursor) {
    total++;
    const raw = doc[field];
    if (raw == null || typeof raw !== "string" || raw === "") { skipped++; continue; }

    const isEncrypted = raw.startsWith("v1:");
    // If already encrypted (re-run case), we can't hash the ciphertext — the
    // plaintext is only recoverable via decrypt(), which needs FIELD_ENCRYPTION_KEY.
    const plaintext = isEncrypted ? require("../utils/fieldCrypto").decrypt(raw) : raw;
    if (!plaintext) { skipped++; continue; }

    const wantHash = hmac(plaintext);
    const needsHashUpdate = doc[hashField] !== wantHash;
    const needsEncrypt    = !isEncrypted;

    if (!needsHashUpdate && !needsEncrypt) { skipped++; continue; }

    const setFields = { [hashField]: wantHash };
    if (needsEncrypt) setFields[field] = encrypt(plaintext);

    if (APPLY) {
      await Model.collection.updateOne({ _id: doc._id }, { $set: setFields });
    }
    updated++;
    if (updated <= 20 || updated % 500 === 0) {
      console.log(`  ${APPLY ? "✅" : "🔍"} ${Model.modelName} ${doc._id}: [${Object.keys(setFields).join(", ")}]`);
    }
  }
  return { updated, skipped, total };
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    console.error("❌ FIELD_ENCRYPTION_KEY not set — cannot encrypt. Set it first.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`\n🔐 WhatsApp lookup-field encryption + hash backfill`);
  console.log(`   Mode: ${APPLY ? "APPLY (will write to DB)" : "DRY-RUN (no writes)"}\n`);

  let totalUpdated = 0;
  for (const target of TARGETS) {
    const name = target.modelPath.split("/").pop();
    process.stdout.write(`▶ ${name} [${target.field}]... `);
    try {
      const { updated, skipped, total } = await migrateCollection(target);
      console.log(`${total} docs — ${updated} to update, ${skipped} already correct`);
      totalUpdated += updated;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  console.log(`\n── Summary ──────────────────────────────────`);
  console.log(`  Documents to update: ${totalUpdated}`);
  if (!APPLY && totalUpdated > 0) {
    console.log(`\n  ℹ  Re-run with --apply to encrypt + backfill hashes now:\n  node scripts/encryptWhatsAppLookupFields.js --apply`);
    console.log(`  Do this immediately after deploying the model/controller changes —`);
    console.log(`  see the warning at the top of this file for why the gap matters.`);
  } else if (APPLY) {
    console.log(`\n  ✅ Done. If your Mongo user has createIndex privileges and autoIndex`);
    console.log(`  is enabled, restart the app now so the new unique index on the hash`);
    console.log(`  field builds cleanly (it would have failed to build before this ran,`);
    console.log(`  since every document had a null hash until now).`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });