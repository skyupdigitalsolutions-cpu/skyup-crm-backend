// scripts/syncNicheTemplates.js
// ─────────────────────────────────────────────────────────────────────────────
// 1. Pulls the FULL current template list from MSG91 into the local
//    WhatsAppTemplate cache (same sync the "Sync Templates" button in the
//    Nurture Sequence Builder triggers — MSG91 has no filter, so this always
//    pulls everything, not just niche templates).
// 2. Cross-checks the cache against the 144 expected niche-fallback template
//    names (9 niches × 4 stages × 4 variations: general_awareness_v1 …
//    whatsapp_action_v4) and reports exactly which exist + are approved,
//    which exist but aren't approved yet, and which don't exist at all.
//
// This is the "first sync, then tell me what's actually there" step before
// writing/submitting any new template copy — no point drafting content for
// templates that already exist.
//
// Usage:
//   node scripts/syncNicheTemplates.js <companyId>
//   node scripts/syncNicheTemplates.js --all      (every company with a WhatsAppConfig)
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }

  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage:\n  node scripts/syncNicheTemplates.js <companyId>\n  node scripts/syncNicheTemplates.js --all");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const Company          = require("../models/Company");
  const WhatsAppConfig    = require("../models/WhatsAppConfig");
  const WhatsAppTemplate  = require("../models/WhatsAppTemplate");
  const { syncTemplatesForCompany } = require("../services/msg91TemplateService");
  const { NICHES, STAGES, NICHE_VARIATION_COUNT, buildNicheTemplateName } = require("../utils/templateNameResolver");

  // ── Build the full list of the 144 expected niche template names ─────────
  const expectedNames = [];
  for (const niche of NICHES) {
    for (const stage of STAGES) {
      for (let v = 1; v <= NICHE_VARIATION_COUNT; v++) {
        expectedNames.push(buildNicheTemplateName(niche, stage, v));
      }
    }
  }
  console.log(`\n📋 Expecting ${expectedNames.length} niche templates (${NICHES.length} niches × ${STAGES.length} stages × ${NICHE_VARIATION_COUNT} variations)\n`);

  // ── Resolve which companies to sync ───────────────────────────────────────
  let companyIds;
  if (arg === "--all") {
    const configs = await WhatsAppConfig.find({}).select("company").lean();
    companyIds = [...new Set(configs.map((c) => String(c.company)))];
    console.log(`🏢 Syncing ${companyIds.length} compan${companyIds.length === 1 ? "y" : "ies"} with a WhatsAppConfig...\n`);
  } else {
    companyIds = [arg];
  }

  for (const companyId of companyIds) {
    const company = await Company.findById(companyId).select("name").lean();
    const label = company ? `"${company.name}" (${companyId})` : companyId;

    console.log(`\n${"─".repeat(70)}\n🔄 Syncing ${label}...`);
    let syncResult;
    try {
      syncResult = await syncTemplatesForCompany(companyId);
      console.log(`✅ Synced ${syncResult.total} template(s) from MSG91 (${syncResult.nurture} industry×service, ${syncResult.other} other/niche/generic)`);
    } catch (err) {
      console.error(`❌ Sync failed for ${label}: ${err.message}`);
      continue;
    }

    // ── Cross-check the cache against the 144 expected niche names ─────────
    const cached = await WhatsAppTemplate.find({
      company: companyId,
      name: { $in: expectedNames },
    }).select("name status").lean();

    const byName = new Map(cached.map((t) => [t.name, t.status]));
    const approved = [];
    const notApproved = [];
    const missing = [];

    for (const name of expectedNames) {
      const status = byName.get(name);
      if (!status) missing.push(name);
      else if (["APPROVED", "ENABLED", "ACTIVE"].includes(String(status).toUpperCase())) approved.push(name);
      else notApproved.push({ name, status });
    }

    console.log(`\n📊 Niche template coverage for ${label}:`);
    console.log(`   ✅ Approved & ready:  ${approved.length} / ${expectedNames.length}`);
    console.log(`   ⚠️  Exists, not approved: ${notApproved.length}`);
    console.log(`   ❌ Missing entirely:  ${missing.length}`);

    // Per-niche breakdown — far more actionable than a flat list once
    // missing.length gets into the dozens: tells you exactly WHICH niches
    // still need content, not just how many template names overall.
    console.log(`\n   Per-niche breakdown (out of ${STAGES.length * NICHE_VARIATION_COUNT} per niche):`);
    for (const niche of NICHES) {
      const nicheNames = expectedNames.filter((n) => n.startsWith(`${niche}_`));
      const nicheApproved = nicheNames.filter((n) => approved.includes(n)).length;
      const nicheNotApproved = nicheNames.filter((n) => notApproved.some((x) => x.name === n)).length;
      const nicheMissing = nicheNames.filter((n) => missing.includes(n)).length;
      const flag = nicheMissing === nicheNames.length ? "❌ ALL MISSING"
        : nicheMissing === 0 && nicheNotApproved === 0 ? "✅ complete"
        : "⚠️  partial";
      console.log(
        `     ${niche.padEnd(10)} approved=${nicheApproved}  notApproved=${nicheNotApproved}  missing=${nicheMissing}   ${flag}`
      );
    }

    if (notApproved.length) {
      console.log(`\n   Not-yet-approved (full list):`);
      notApproved.forEach(({ name, status }) => console.log(`     - ${name} (status: ${status})`));
    }

    if (missing.length) {
      console.log(`\n   Missing (full list, ${missing.length}):`);
      missing.forEach((name) => console.log(`     - ${name}`));
    }
  }

  console.log(`\n${"─".repeat(70)}\nDone.\n`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error("Script failed:", e); process.exit(1); });
