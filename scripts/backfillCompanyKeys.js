// scripts/backfillCompanyKeys.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME BACKFILL: generates an encryption key for every EXISTING company
// that doesn't have one yet.
//
// WHY THIS IS NEEDED
//   Key generation only runs when a NEW company is created. Companies that
//   existed before the encryption feature was deployed have
//   encryptedCompanyKey = null, so their admins receive companyKey: null at
//   login and could never encrypt/decrypt anything.
//
// WHAT IT DOES
//   For each company with no encryptedCompanyKey:
//     1. Generates a random 32-byte key
//     2. Encrypts it with SYSTEM_MASTER_KEY
//     3. Stores the encrypted version in Company.encryptedCompanyKey
//     4. Prints the RAW key so you can give it to that company's admin
//
// SAFETY
//   • Idempotent — companies that already have a key are skipped entirely.
//   • Never overwrites an existing key (that would make their data unreadable).
//   • Dry-run by default. Pass --apply to write.
//
// ⚠️  IMPORTANT: The raw keys printed by this script are the ONLY copy that
//     will ever be shown in plaintext. Save the output somewhere secure and
//     deliver each key to the right company admin. After this, the key can
//     only be retrieved by the backend at login — never displayed again.
//
// USAGE
//   node scripts/backfillCompanyKeys.js            ← dry-run, shows what it would do
//   node scripts/backfillCompanyKeys.js --apply    ← generates and stores keys
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");
const {
  generateCompanyKey,
  encryptCompanyKey,
  computeHmac,
} = require("../utils/companyKeyCrypto");

const APPLY = process.argv.includes("--apply");

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGO_URI not set");
    process.exit(1);
  }
  if (!process.env.SYSTEM_MASTER_KEY) {
    console.error(
      "❌ SYSTEM_MASTER_KEY not set — cannot encrypt company keys.\n" +
      "   Generate one:  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
      "   Then add it to your Render environment variables."
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  const Company = require("../models/Company");

  console.log(`\n🔑 Company encryption key backfill`);
  console.log(`   Mode: ${APPLY ? "APPLY (will write to DB)" : "DRY-RUN (no writes)"}\n`);

  // Find companies with no key yet. select("+encryptedCompanyKey") is required
  // because the field is select:false in the schema.
  const companies = await Company.find({})
    .select("+encryptedCompanyKey name email")
    .lean();

  const needsKey = companies.filter((c) => !c.encryptedCompanyKey);
  const hasKey   = companies.length - needsKey.length;

  console.log(`   Total companies:      ${companies.length}`);
  console.log(`   Already have a key:   ${hasKey} (skipped)`);
  console.log(`   Need a key:           ${needsKey.length}\n`);

  if (needsKey.length === 0) {
    console.log("✅ Every company already has an encryption key. Nothing to do.\n");
    await mongoose.disconnect();
    process.exit(0);
  }

  const generated = [];

  for (const company of needsKey) {
    if (!APPLY) {
      console.log(`  🔍 ${company.name} (${company._id}) — would generate a key`);
      continue;
    }

    try {
      const rawKey  = generateCompanyKey();
      const encKey  = encryptCompanyKey(rawKey);
      const keyHash = computeHmac(rawKey, rawKey);

      await Company.updateOne(
        { _id: company._id },
        { $set: { encryptedCompanyKey: encKey, recoveryKeyHash: keyHash } }
      );

      generated.push({ name: company.name, email: company.email, id: String(company._id), key: rawKey });
      console.log(`  ✅ ${company.name} (${company._id}) — key generated`);
    } catch (e) {
      console.error(`  ❌ ${company.name} (${company._id}) — FAILED: ${e.message}`);
    }
  }

  console.log(`\n── Summary ──────────────────────────────────`);

  if (!APPLY) {
    console.log(`  Would generate keys for ${needsKey.length} company(ies).`);
    console.log(`\n  ℹ  Re-run with --apply to generate them:`);
    console.log(`  node scripts/backfillCompanyKeys.js --apply\n`);
  } else {
    console.log(`  Generated ${generated.length} key(s).\n`);
    console.log(`⚠️  SAVE THE KEYS BELOW — this is the only time they are shown.`);
    console.log(`   Deliver each key securely to that company's admin.\n`);
    console.log(`═══════════════════════════════════════════════════════════════`);
    for (const g of generated) {
      console.log(`\n  Company : ${g.name}`);
      console.log(`  Email   : ${g.email || "(none)"}`);
      console.log(`  ID      : ${g.id}`);
      console.log(`  KEY     : ${g.key}`);
    }
    console.log(`\n═══════════════════════════════════════════════════════════════\n`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("❌ Backfill error:", e.message);
  process.exit(1);
});