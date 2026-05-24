// scripts/diag-users.js
// Quick read-only diagnostic: print every user + lead/conv mapping for one phone.
// Usage:
//   node scripts/diag-users.js --uri="<prod-URI>" --phone=919538281101
//   node scripts/diag-users.js --phone=919538281101         # uses .env URI

require("dotenv").config();
const mongoose = require("mongoose");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const Lead = require("../models/Leads");
const User = require("../models/Users");

const uriArg   = process.argv.find((a) => a.startsWith("--uri="));
const phoneArg = process.argv.find((a) => a.startsWith("--phone="));
const uri      = uriArg ? uriArg.slice(6) : (process.env.MONGO_URI || process.env.MONGODB_URI);
const phone    = phoneArg ? phoneArg.slice(8) : null;

if (!uri)   { console.error("❌ pass --uri= or set MONGO_URI"); process.exit(1); }
if (!phone) { console.error("❌ pass --phone=919XXXXXXXXX");    process.exit(1); }

function normalize(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0091")) d = d.slice(4);
  if (d.startsWith("0") && d.length === 11) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  return d;
}

(async () => {
  await mongoose.connect(uri);
  const conn = mongoose.connection;
  console.log(`✅ host=${conn.host}  db=${conn.name}\n`);

  console.log("👥 USERS:");
  const users = await User.find({}).select("_id name email role company").lean();
  users.forEach((u) => {
    console.log(`   ${u._id}  ${(u.name||"?").padEnd(20)} ${(u.email||"").padEnd(30)} role=${u.role}`);
  });

  const wa = normalize(phone);
  const lastTen = wa.slice(-10);
  console.log(`\n🔍 Looking up leads for phone ${phone} (normalized ${wa}, lastTen ${lastTen}):`);
  const leads = await Lead.find({
    $or: [{ mobile: wa }, { mobile: lastTen }, { mobile: `+${wa}` }],
  }).select("_id name mobile user company").lean();

  if (!leads.length) console.log("   (none found)");
  for (const l of leads) {
    const owner = users.find((u) => u._id.toString() === l.user?.toString());
    console.log(`   Lead ${l._id}  name="${l.name}"  mobile="${l.mobile}"  user=${l.user}  ownerName="${owner?.name || "?"}"`);
  }

  console.log(`\n🔍 Looking up conversations for waPhone:`);
  const convs = await WhatsAppConversation.find({
    $or: [{ waPhone: wa }, { waPhone: lastTen }, { waPhone: `+${wa}` }],
  }).select("_id waPhone lead assignedAgent company contactName").lean();

  if (!convs.length) console.log("   (none found)");
  for (const c of convs) {
    const agent = users.find((u) => u._id.toString() === c.assignedAgent?.toString());
    console.log(`   Conv ${c._id}  waPhone=${c.waPhone}  contact="${c.contactName}"  lead=${c.lead}  assignedAgent=${c.assignedAgent}  agentName="${agent?.name || "?"}"`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });