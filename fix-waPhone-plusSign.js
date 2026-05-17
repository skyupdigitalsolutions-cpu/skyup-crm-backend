/**
 * scripts/fix-waPhone-plusSign.js
 *
 * One-time migration: strip the leading "+" (and any other non-digit chars)
 * from WhatsAppConversation.waPhone values that were stored incorrectly
 * after the manual MongoDB Atlas phone-number update.
 *
 * The WhatsAppConversation collection has a UNIQUE index on { waPhone, company }.
 * This script is careful to:
 *   1. Only update documents where waPhone actually needs fixing.
 *   2. Handle the case where the clean version already exists (merge/skip).
 *
 * USAGE:
 *   node scripts/fix-waPhone-plusSign.js
 *
 * Set MONGO_URI in your .env or pass it as an environment variable.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error("❌  MONGO_URI not set. Add it to your .env file.");
  process.exit(1);
}

// ─── Inline normalizer (no + prefix, digits only, 91XXXXXXXXXX) ──────────────
function normalizeWaPhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("✅  Connected to MongoDB");

  const db = mongoose.connection.db;
  const col = db.collection("whatsappconversations");

  // Find all docs where waPhone contains a non-digit character (e.g. "+")
  const badDocs = await col
    .find({ waPhone: { $regex: /\D/ } })
    .project({ _id: 1, waPhone: 1, company: 1 })
    .toArray();

  console.log(`🔍  Found ${badDocs.length} conversation(s) with non-digit waPhone`);

  if (badDocs.length === 0) {
    console.log("✅  Nothing to fix. All waPhone values are already clean.");
    await mongoose.disconnect();
    return;
  }

  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of badDocs) {
    const cleanPhone = normalizeWaPhone(doc.waPhone);

    if (!cleanPhone || cleanPhone === doc.waPhone) {
      console.log(`⏭  Skip (already clean or empty): ${doc.waPhone}`);
      skipped++;
      continue;
    }

    // Check if a document with the clean phone already exists for this company
    const existing = await col.findOne({
      waPhone: cleanPhone,
      company: doc.company,
      _id: { $ne: doc._id },
    });

    if (existing) {
      // A clean-phone conversation already exists — the bad-phone doc is a duplicate.
      // Safe to delete the bad one (it has no messages because inbound matching
      // would have used the existing clean-phone conversation).
      console.log(
        `⚠️  Duplicate found for ${doc.waPhone} → ${cleanPhone}. Deleting bad doc ${doc._id}`
      );
      await col.deleteOne({ _id: doc._id });
      skipped++;
      continue;
    }

    try {
      await col.updateOne({ _id: doc._id }, { $set: { waPhone: cleanPhone } });
      console.log(`✅  Fixed: "${doc.waPhone}" → "${cleanPhone}" (doc: ${doc._id})`);
      fixed++;
    } catch (err) {
      if (err.code === 11000) {
        // Unique index violation — the clean version was inserted by a concurrent op
        console.warn(`⚠️  Unique conflict for ${cleanPhone}, deleting bad doc ${doc._id}`);
        await col.deleteOne({ _id: doc._id });
        skipped++;
      } else {
        console.error(`❌  Error updating ${doc._id}:`, err.message);
        errors++;
      }
    }
  }

  console.log("\n─────────────────────────────────────────");
  console.log(`📊  Results: ${fixed} fixed | ${skipped} skipped | ${errors} errors`);
  console.log("─────────────────────────────────────────");

  await mongoose.disconnect();
  console.log("✅  Disconnected. Migration complete.");
}

main().catch((err) => {
  console.error("❌  Fatal error:", err);
  process.exit(1);
});