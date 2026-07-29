// checkWebsiteCampaign.js
// ─────────────────────────────────────────────────────────────────────────────
// One-off diagnostic for a Website-source campaign (WebsiteConfig).
// Prints the secret, active state, company, page URL, assigned users, and how
// many leads are actually stored under it — and verifies that the secret your
// landing-page script sends resolves to this config.
//
// RUN (locally, with your backend .env present):
//   node checkWebsiteCampaign.js
//
// Optionally override what to look for:
//   SOURCE_NAME="SkyupCRM" SECRET="<your-secret>" node checkWebsiteCampaign.js
//
// Safe & read-only — it does NOT modify anything.
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");

// What the landing-page script sends, and the campaign name shown in the UI.
// SECURITY (A.5.17): no hardcoded credential. Supply the secret at runtime.
// NOTE: the previously committed value must be treated as compromised and
// rotated in WebsiteConfig and in the landing-page GTM tag.
const SECRET_TO_TEST = process.env.SECRET;
if (!SECRET_TO_TEST) {
  console.error('Missing SECRET. Usage: SOURCE_NAME="..." SECRET="..." node checkWebsiteCampaign.js');
  process.exit(1);
}
const SOURCE_NAME     = process.env.SOURCE_NAME || "SkyupCRM";

// Try common env var names for the Mongo connection string.
const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL ||
  process.env.DB_URI;

(async () => {
  if (!MONGO_URI) {
    console.error("❌ No Mongo connection string found in .env (looked for MONGO_URI / MONGODB_URI / DATABASE_URL / DB_URI).");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB\n");

  // Minimal inline schemas (so this script needs no imports from the app).
  const WebsiteConfig = mongoose.model(
    "WebsiteConfig",
    new mongoose.Schema({}, { strict: false, collection: "websiteconfigs" })
  );
  const Lead = mongoose.model(
    "Lead",
    new mongoose.Schema({}, { strict: false, collection: "leads" })
  );
  const User = mongoose.model(
    "User",
    new mongoose.Schema({}, { strict: false, collection: "users" })
  );
  const Company = mongoose.model(
    "Company",
    new mongoose.Schema({}, { strict: false, collection: "companies" })
  );

  console.log("════════════════════════════════════════════════════════════");
  console.log(` 1. SECRET CHECK — does "${SECRET_TO_TEST}" resolve to a config?`);
  console.log("════════════════════════════════════════════════════════════");
  const bySecret = await WebsiteConfig.findOne({ webhookSecret: SECRET_TO_TEST }).lean();
  if (bySecret) {
    console.log(`✅ YES — secret "${SECRET_TO_TEST}" matches config "${bySecret.sourceName}" (id ${bySecret._id})`);
  } else {
    console.log(`❌ NO — the secret "${SECRET_TO_TEST}" your script sends matches NO WebsiteConfig.`);
    console.log("   → This is why leads are dropped. Fix by making the script's SECRET_KEY equal");
    console.log("     the campaign's real webhookSecret, OR set this config's webhookSecret to it.");
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(` 2. ALL Website campaigns (WebsiteConfig documents)`);
  console.log("════════════════════════════════════════════════════════════");
  const all = await WebsiteConfig.find({}).lean();
  if (!all.length) {
    console.log("⚠️  No WebsiteConfig documents exist at all.");
  }
  for (const c of all) {
    const leadCount = await Lead.countDocuments({ company: c.company, campaign: c.sourceName });
    console.log(`\n • sourceName    : "${c.sourceName}"${c.sourceName === SOURCE_NAME ? "   ← the one you're asking about" : ""}`);
    console.log(`   _id           : ${c._id}`);
    console.log(`   webhookSecret : "${c.webhookSecret}"`);
    console.log(`   isActive      : ${c.isActive}`);
    console.log(`   pageUrl       : "${c.pageUrl || "(empty)"}"`);
    console.log(`   defaultStatus : "${c.defaultStatus}"`);
    console.log(`   company       : ${c.company}`);
    console.log(`   roundRobinIdx : ${c.roundRobinIndex}`);
    console.log(`   leads stored  : ${leadCount}  (Lead docs with campaign="${c.sourceName}")`);
  }

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(` 3. DETAIL for "${SOURCE_NAME}"`);
  console.log("════════════════════════════════════════════════════════════");
  const cfg = await WebsiteConfig.findOne({ sourceName: SOURCE_NAME }).lean();
  if (!cfg) {
    console.log(`⚠️  No WebsiteConfig named "${SOURCE_NAME}" found. Check the exact name (case-sensitive).`);
  } else {
    const company = await Company.findById(cfg.company).select("name isActive").lean();
    const users = await User.find({ company: cfg.company, isActive: { $ne: false } })
      .select("name email").lean();
    const leadCount = await Lead.countDocuments({ company: cfg.company, campaign: cfg.sourceName });

    console.log(`Company        : ${company ? `"${company.name}" (active=${company.isActive})` : "⚠️ company not found"}`);
    console.log(`Active users   : ${users.length}  ${users.length ? "(round-robin will assign to these)" : "⚠️ NONE — leads will be unassigned"}`);
    users.forEach((u, i) => console.log(`   ${i + 1}. ${u.name} <${u.email}>`));
    console.log(`Leads stored   : ${leadCount}`);

    console.log("\n── Verdict ─────────────────────────────────────────────────");
    const problems = [];
    if (cfg.webhookSecret !== SECRET_TO_TEST)
      problems.push(`Secret MISMATCH: config has "${cfg.webhookSecret}" but script sends "${SECRET_TO_TEST}".`);
    if (!cfg.isActive) problems.push("Config isActive = false (campaign paused).");
    if (!company)      problems.push("Linked company not found.");
    if (company && company.isActive === false) problems.push("Linked company is suspended (isActive=false).");
    if (!users.length) problems.push("No active users → leads save but stay unassigned.");

    if (problems.length === 0) {
      console.log("✅ Config looks correct. If leads still aren't arriving, the request isn't");
      console.log("   reaching the backend — check the browser console for 'CRM: lead sent 200'");
      console.log("   vs 'CRM: fetch failed' (CORS), and confirm the crm_lead event fires on submit.");
    } else {
      problems.forEach((p) => console.log("❌ " + p));
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Script error:", err.message);
  process.exit(1);
});