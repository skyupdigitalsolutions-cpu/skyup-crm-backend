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

  await mongoose.connect(uri);
  console.log(`✅  Connected to Mongo  (mode: ${APPLY ? "APPLY" : "DRY-RUN"})`);

  // Pull EVERY conversation — we'll resolve the lead by phone for any missing refs.
  const convs = await WhatsAppConversation.find({})
    .select("_id waPhone assignedAgent lead company")
    .lean();

  console.log(`📋  Found ${convs.length} conversations total`);

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
      // We can still backfill the lead ref even if there's no owner yet.
      noOwner++;
    } else if (currentAgent !== leadOwnerId) {
      patch.assignedAgent = leadOwnerId;
    } else {
      // Agent already correct — only count it as "already" when there's
      // also no lead-ref backfill needed.
      if (!patch.lead) alreadyCorrect++;
    }

    if (!Object.keys(patch).length) continue;

    const tags = [];
    if (patch.lead)          { tags.push(`lead=${lead._id}`);                       leadBackfilled++; }
    if (patch.assignedAgent) { tags.push(`agent ${currentAgent || "null"} → ${leadOwnerId}`); agentRealigned++; }

    console.log(
      `🔁  Conv ${conv._id}  (${lead.name || conv.waPhone})  ${tags.join("  |  ")}`
    );

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