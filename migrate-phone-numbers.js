// migrate-phone-numbers.js
// One-time migration script to prefix all existing WhatsApp conversation
// phone numbers and Lead mobile numbers with country code 91.
//
// Run ONCE from your backend root directory:
//   node migrate-phone-numbers.js
//
// Safe to run multiple times — already-correct numbers are skipped.

require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/skyup-crm";

// ── Same normalizePhone logic as the controllers ──────────────────────────────
function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}

function needsNormalization(phone) {
  if (!phone) return false;
  const digits = String(phone).replace(/\D/g, "");
  // Already has 91 prefix and is 12 digits → correct
  if (digits.length === 12 && digits.startsWith("91")) return false;
  // 10-digit bare number → needs prefix
  if (digits.length === 10) return true;
  // Anything else (international non-Indian, already correct) → skip
  return false;
}

async function migrate() {
  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected:", MONGO_URI.replace(/:\/\/.*@/, "://***@"));

  // ── 1. Fix WhatsAppConversation.waPhone ─────────────────────────────────────
  console.log("\n📱 Fixing WhatsAppConversation.waPhone ...");

  const convCollection = mongoose.connection.collection("whatsappconversations");
  const allConvs = await convCollection.find({}).toArray();

  let convFixed = 0, convSkipped = 0, convErrors = 0;

  for (const conv of allConvs) {
    if (!needsNormalization(conv.waPhone)) {
      convSkipped++;
      continue;
    }
    const normalized = normalizePhone(conv.waPhone);
    try {
      // Check if a conversation with the normalized number already exists
      // (could happen if the same lead created two records with/without prefix)
      const duplicate = await convCollection.findOne({
        waPhone:  normalized,
        company:  conv.company,
        _id:      { $ne: conv._id },
      });

      if (duplicate) {
        console.log(`  ⚠️  Duplicate found for ${conv.waPhone} → ${normalized} (conv ${conv._id}). Skipping to avoid conflict.`);
        convSkipped++;
        continue;
      }

      await convCollection.updateOne(
        { _id: conv._id },
        { $set: { waPhone: normalized } }
      );
      console.log(`  ✅ Conv ${conv._id}: ${conv.waPhone} → ${normalized}`);
      convFixed++;
    } catch (err) {
      console.error(`  ❌ Conv ${conv._id} (${conv.waPhone}): ${err.message}`);
      convErrors++;
    }
  }

  console.log(`\n  Conversations — fixed: ${convFixed}, skipped: ${convSkipped}, errors: ${convErrors}`);

  // ── 2. Fix Lead.mobile ───────────────────────────────────────────────────────
  console.log("\n👤 Fixing Lead.mobile numbers ...");

  const leadCollection = mongoose.connection.collection("leads");
  const allLeads = await leadCollection.find({
    mobile: { $exists: true, $ne: "" }
  }).toArray();

  let leadFixed = 0, leadSkipped = 0, leadErrors = 0;

  for (const lead of allLeads) {
    if (!needsNormalization(lead.mobile)) {
      leadSkipped++;
      continue;
    }
    const normalized = normalizePhone(lead.mobile);
    try {
      await leadCollection.updateOne(
        { _id: lead._id },
        { $set: { mobile: normalized, normalizedPhone: normalized.slice(-10) } }
      );
      console.log(`  ✅ Lead ${lead._id} (${lead.name || "?"}): ${lead.mobile} → ${normalized}`);
      leadFixed++;
    } catch (err) {
      console.error(`  ❌ Lead ${lead._id} (${lead.mobile}): ${err.message}`);
      leadErrors++;
    }
  }

  console.log(`\n  Leads — fixed: ${leadFixed}, skipped: ${leadSkipped}, errors: ${leadErrors}`);

  // ── 3. Fix SmsLog.to ─────────────────────────────────────────────────────────
  console.log("\n💬 Fixing SmsLog.to numbers ...");

  const smsCollection = mongoose.connection.collection("smslogs");
  const allSms = await smsCollection.find({
    to: { $exists: true, $ne: "" }
  }).toArray();

  let smsFixed = 0, smsSkipped = 0;

  for (const log of allSms) {
    if (!needsNormalization(log.to)) { smsSkipped++; continue; }
    const normalized = normalizePhone(log.to);
    await smsCollection.updateOne({ _id: log._id }, { $set: { to: normalized } });
    smsFixed++;
  }

  console.log(`  SMS logs — fixed: ${smsFixed}, skipped: ${smsSkipped}`);

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ Migration complete`);
  console.log(`   WhatsApp conversations fixed : ${convFixed}`);
  console.log(`   Leads fixed                  : ${leadFixed}`);
  console.log(`   SMS logs fixed               : ${smsFixed}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});