// scripts/encryptExistingSensitiveFields.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME MIGRATION: encrypts the "safe tier" personal-data fields already in
// MongoDB (IP addresses + display phone numbers that are NOT queried by value).
//
// Covers:
//   AccessAuditLog.ip
//   Company.phone
//   SmsLog.to
//   TermsAcceptance.ipAddress
//   Users.ipAddress, Users.lastIpAddress   (lastIpAddress = legacy field)
//   WhatsAppConfig.phoneNumber              (usually empty → nothing to do)
//
// It deliberately does NOT touch the fields that back unique indexes / equality
// lookups (Leads.leadgenId, Leads.mobile, MobileCallLog.phoneNumber,
// WhatsAppConversation.waPhone, WhatsAppTemplate.integratedNumber,
// WhatsAppConfig.msg91IntegratedNumber). Those need the deterministic-HMAC
// approach + query rewrites and are handled separately.
//
// Writes with the RAW driver (Model.collection.updateOne) so it bypasses
// Mongoose middleware — this is what lets it migrate the append-only
// AccessAuditLog collection, whose schema blocks normal updates.
//
// Safe to run repeatedly — values already starting "v1:" are skipped.
// Dry-run by default; pass --apply to actually write.
//
// Usage:
//   node scripts/encryptExistingSensitiveFields.js           ← dry-run (no writes)
//   node scripts/encryptExistingSensitiveFields.js --apply   ← encrypt in place
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");
const { encrypt } = require("../utils/fieldCrypto");

const APPLY = process.argv.includes("--apply");

const TARGETS = [
  { modelPath: "../models/AccessAuditLog", fields: ["ip"] },
  { modelPath: "../models/Company",        fields: ["phone"] },
  { modelPath: "../models/SmsLog",         fields: ["to"] },
  { modelPath: "../models/TermsAcceptance",fields: ["ipAddress"] },
  { modelPath: "../models/Users",          fields: ["ipAddress", "lastIpAddress"] },
  { modelPath: "../models/WhatsAppConfig", fields: ["phoneNumber"] },
];

async function migrateCollection({ modelPath, fields }) {
  const Model = require(modelPath);
  // Read at the raw-collection level so schema selects / append-only guards /
  // decrypt hooks don't interfere, and so legacy fields not in the schema
  // (e.g. Users.lastIpAddress) are still visible.
  const projection = { _id: 1 };
  fields.forEach((f) => (projection[f] = 1));

  const cursor = Model.collection.find({}, { projection });
  let updated = 0, skipped = 0, total = 0;

  for await (const doc of cursor) {
    total++;
    const setFields = {};
    for (const field of fields) {
      const val = doc[field];
      if (val == null || typeof val !== "string" || val === "") continue;
      if (val.startsWith("v1:")) { skipped++; continue; } // already encrypted
      setFields[field] = encrypt(val);
    }
    if (Object.keys(setFields).length === 0) continue;
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
  console.log(`\n🔐 Safe-tier personal-data encryption migration`);
  console.log(`   Mode: ${APPLY ? "APPLY (will write to DB)" : "DRY-RUN (no writes)"}\n`);

  let totalUpdated = 0;
  for (const target of TARGETS) {
    const name = target.modelPath.split("/").pop();
    process.stdout.write(`▶ ${name} [${target.fields.join(", ")}]... `);
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
    console.log(`\n  ℹ  Re-run with --apply to encrypt them:\n  node scripts/encryptExistingSensitiveFields.js --apply`);
  } else if (APPLY) {
    console.log(`\n  ✅ Done. All plaintext values in scope have been encrypted.`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });