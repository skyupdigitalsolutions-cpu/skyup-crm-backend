// scripts/fixWhatsAppPlaceholderLeads.js
// ─────────────────────────────────────────────────────────────────────────────
// One-time cleanup for WhatsApp chats/leads stuck as "Sir/Madam".
//
// What it does (per company):
//   1. Links chats that have NO lead to an existing lead with the same number.
//   2. Copies a real lead name onto chats still labelled "Sir/Madam".
//   3. Renames leads still called "Sir/Madam …" when their chat has a real name.
//   4. Reports WhatsApp leads with no employee AND no admin — these are
//      invisible to regular admins. Assign them from the WhatsApp inbox
//      (Assign button) or as super admin from the Leads page.
//
// DRY RUN by default — nothing is written. Add --apply to save changes:
//   node scripts/fixWhatsAppPlaceholderLeads.js            # report only
//   node scripts/fixWhatsAppPlaceholderLeads.js --apply    # make the changes
//   node scripts/fixWhatsAppPlaceholderLeads.js --apply --company=<companyId>
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");
const Lead = require("../models/Leads");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const { normalizePhone } = require("../utils/normalizePhone");
const { isRealName } = require("../utils/getLeadDisplayName");

const APPLY = process.argv.includes("--apply");
const companyArg = (process.argv.find((a) => a.startsWith("--company=")) || "").split("=")[1] || null;

async function findLeadForWaPhone(waPhone, companyId) {
  const digits = String(waPhone || "").replace(/\D/g, "");
  if (!digits) return null;
  const lastTen = digits.slice(-10);
  const norm = normalizePhone(digits);
  const or = [{ mobile: digits }, { mobile: lastTen }, { mobile: `+${digits}` }, { mobile: `91${lastTen}` }];
  if (norm) or.push({ normalizedPhone: norm }, { normalizedSecondaryPhone: norm });
  return Lead.findOne({ company: companyId, mergedInto: null, $or: or }).sort({ updatedAt: -1 });
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/skyup-crm");
  console.log(APPLY ? "APPLY mode — changes WILL be saved.\n" : "DRY RUN — nothing will be saved. Re-run with --apply to make changes.\n");

  const convFilter = companyArg ? { company: companyArg } : {};
  const stats = { linked: 0, chatRenamed: 0, leadRenamed: 0, scanned: 0 };

  // Batched find() rather than .cursor(): the encryption plugin decrypts
  // waPhone in post("find") hooks, which do not run for query cursors.
  const BATCH = 200;
  let lastId = null;
  for (;;) {
    const page = await WhatsAppConversation.find(lastId ? { ...convFilter, _id: { $gt: lastId } } : convFilter)
      .sort({ _id: 1 }).limit(BATCH);
    if (!page.length) break;
    lastId = page[page.length - 1]._id;
  for (const conv of page) {
    stats.scanned++;
    let lead = conv.lead ? await Lead.findOne({ _id: conv.lead, company: conv.company }) : null;

    // 1. Link chats with no lead to an existing lead with the same number.
    if (!lead) {
      lead = await findLeadForWaPhone(conv.waPhone, conv.company);
      if (lead) {
        stats.linked++;
        console.log(`link   chat ${conv._id} (+${conv.waPhone}) → lead "${lead.name}" (${lead._id})`);
        if (APPLY) await WhatsAppConversation.updateOne({ _id: conv._id }, { lead: lead._id });
      }
    }
    if (!lead) continue;

    // 2. Chat still "Sir/Madam" but the lead has a real name → use it.
    if (!isRealName(conv.contactName) && isRealName(lead.name)) {
      stats.chatRenamed++;
      console.log(`rename chat ${conv._id}: "${conv.contactName || ""}" → "${lead.name}"`);
      if (APPLY) await WhatsAppConversation.updateOne({ _id: conv._id }, { contactName: lead.name.trim() });
    }

    // 3. Lead still "Sir/Madam …" but the chat has a real name → use it.
    if (!isRealName(lead.name) && isRealName(conv.contactName)) {
      stats.leadRenamed++;
      console.log(`rename lead ${lead._id}: "${lead.name}" → "${conv.contactName.trim()}"`);
      if (APPLY) { lead.name = conv.contactName.trim(); await lead.save(); }
    }
  }
  }

  // 4. Report WhatsApp leads invisible to regular admins.
  const orphanFilter = { source: "WhatsApp", mergedInto: null, user: null, assignedAdmin: null };
  if (companyArg) orphanFilter.company = new mongoose.Types.ObjectId(companyArg);
  const orphans = await Lead.aggregate([
    { $match: orphanFilter },
    { $group: { _id: "$company", count: { $sum: 1 } } },
  ]);

  console.log("\n── Summary ─────────────────────────────────────────");
  console.log(`Chats scanned:                     ${stats.scanned}`);
  console.log(`Chats linked to an existing lead:  ${stats.linked}`);
  console.log(`Chats renamed from Sir/Madam:      ${stats.chatRenamed}`);
  console.log(`Leads renamed from Sir/Madam:      ${stats.leadRenamed}`);
  const orphanTotal = orphans.reduce((n, o) => n + o.count, 0);
  console.log(`Unassigned WhatsApp leads (no employee, no admin): ${orphanTotal}`);
  for (const o of orphans) console.log(`   company ${o._id}: ${o.count}`);
  if (orphanTotal) console.log("   → Assign these from the WhatsApp inbox (Assign button) or as super admin from the Leads page.");
  if (!APPLY) console.log("\nDry run only. Re-run with --apply to save these changes.");

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("fixWhatsAppPlaceholderLeads failed:", err);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
