// scripts/realign-conv-agents.js
// ─────────────────────────────────────────────────────────────────────────────
// One-off backfill for WhatsApp conversations:
//   1. Backfill conversation.lead by matching waPhone → Lead.mobile (scoped
//      by company). Many older convs have lead:null because startConversation
//      ran with a broken lead lookup.
//   2. Realign conversation.assignedAgent to the lead's owner (lead.user) so
//      real-time inbound messages route to the correct employee's socket.
//
// Usage:
//   node scripts/realign-conv-agents.js           # dry-run (prints diff only)
//   node scripts/realign-conv-agents.js --apply   # actually update
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");

const WhatsAppConversation = require("../models/WhatsAppConversation");
const Lead                 = require("../models/Leads");

const APPLY = process.argv.includes("--apply");

// Same phone normalisation used by the webhook (controllers/msg91WebhookController.js)
function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}

async function findLeadByPhone(waPhone, companyId) {
  if (!waPhone) return null;
  const lastTen = waPhone.slice(-10);
  return Lead.findOne({
    company: companyId,
    $or: [
      { mobile: waPhone },
      { mobile: lastTen },
      { mobile: `+${waPhone}` },
    ],
  }).select("user mobile name").lean();
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌  MONGO_URI not set in .env");
    process.exit(1);
  }

  // Mask credentials before printing — show host + db only
  const masked = uri.replace(/:\/\/[^@]+@/, "://***:***@");
  console.log(`🔗  URI: ${masked}`);

  await mongoose.connect(uri);

  const conn = mongoose.connection;
  console.log(`✅  Connected — host=${conn.host}  db=${conn.name}  (mode: ${APPLY ? "APPLY" : "DRY-RUN"})`);

  // Diagnostics: list collections + their doc counts so we can immediately
  // tell whether we're pointed at the right database.
  const colls = await conn.db.listCollections().toArray();
  console.log(`🗂   ${colls.length} collections in this DB:`);
  for (const c of colls) {
    const count = await conn.db.collection(c.name).countDocuments();
    const star  = /whatsapp|lead/i.test(c.name) ? "  ⭐" : "";
    console.log(`     ${c.name.padEnd(40)} ${String(count).padStart(6)} docs${star}`);
  }

  // Pull EVERY conversation — we'll resolve the lead by phone for any missing refs.
  const convs = await WhatsAppConversation.find({})
    .select("_id waPhone assignedAgent lead company")
    .lean();

  console.log(`\n📋  Found ${convs.length} conversations total (via WhatsAppConversation model)\n`);

  if (convs.length === 0) {
    console.warn("⚠️   Zero conversations found. Likely causes:");
    console.warn("     1. .env MONGO_URI points to a different database than production");
    console.warn("     2. The DB name in the URI path is missing or wrong");
    console.warn("        (URI format: mongodb+srv://user:pass@cluster/<DB_NAME>?...)");
    console.warn("     3. The convs live in a collection named differently than 'whatsappconversations'");
    console.warn("     Check the collection list above — if you see 'whatsappconversations'");
    console.warn("     with docs, but this query returned 0, run with .env pointing at the");
    console.warn("     production URI.");
    await mongoose.disconnect();
    process.exit(0);
  }

  let leadBackfilled  = 0;
  let agentRealigned  = 0;
  let noCompany       = 0;
  let noLead          = 0;
  let noOwner         = 0;
  let alreadyCorrect  = 0;

  for (const conv of convs) {
    if (!conv.company) { noCompany++; continue; }

    // Try to resolve lead — by ref first, fall back to phone match.
    let lead = null;
    if (conv.lead) {
      lead = await Lead.findById(conv.lead).select("user mobile name").lean();
    }
    if (!lead) {
      const waPhone = normalizePhone(conv.waPhone);
      lead = await findLeadByPhone(waPhone, conv.company);
    }

    if (!lead) { noLead++; continue; }

    const patch = {};
    if (!conv.lead) {
      patch.lead = lead._id;
    }

    const leadOwnerId  = lead.user?.toString() || null;
    const currentAgent = conv.assignedAgent?.toString() || null;

    if (!leadOwnerId) {
      noOwner++;
    } else if (currentAgent !== leadOwnerId) {
      patch.assignedAgent = leadOwnerId;
    } else {
      if (!patch.lead) alreadyCorrect++;
    }

    if (!Object.keys(patch).length) continue;

    const tags = [];
    if (patch.lead)          { tags.push(`lead=${lead._id}`);                                       leadBackfilled++; }
    if (patch.assignedAgent) { tags.push(`agent ${currentAgent || "null"} → ${leadOwnerId}`);       agentRealigned++; }

    console.log(`🔁  Conv ${conv._id}  (${lead.name || conv.waPhone})  ${tags.join("  |  ")}`);

    if (APPLY) {
      await WhatsAppConversation.updateOne({ _id: conv._id }, { $set: patch });
    }
  }

  console.log("─".repeat(60));
  console.log(`Summary  ${APPLY ? "(APPLIED)" : "(dry-run)"}`);
  console.log(`  total convs scanned : ${convs.length}`);
  console.log(`  lead ref backfilled : ${leadBackfilled}`);
  console.log(`  agent realigned     : ${agentRealigned}`);
  console.log(`  already correct     : ${alreadyCorrect}`);
  console.log(`  lead has no owner   : ${noOwner}`);
  console.log(`  no matching lead    : ${noLead}`);
  console.log(`  no company on conv  : ${noCompany}`);
  console.log("─".repeat(60));

  if (!APPLY && (leadBackfilled + agentRealigned) > 0) {
    console.log("ℹ️   Re-run with --apply to commit the changes.");
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌  Script failed:", err);
  process.exit(1);
});