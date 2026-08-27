// scripts/checkDuplicateRules.js
// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY — checks for the exact issue that produces two identical
// "Nurture automation · New → awareness (auto) · SKIPPED" rows for the same
// lead at the same timestamp: two or more ENABLED NurtureRule documents for
// the same company independently targeting the same action.whatsapp.
// statusStage. Every one of nurtureSequenceJob.js's dedup layers (atomic
// claim, alreadyFiredToday, templateHistory cross-check) is keyed per RULE —
// they correctly stop the SAME rule from firing twice, but do nothing to
// stop two DIFFERENT rules from both evaluating (and both logging, sent or
// skipped) the same lead on the same run. That's by design when genuinely
// intentional (a deliberate multi-touch sequence), but far more often it's
// a leftover duplicate rule from testing/iteration that should be disabled
// or deleted.
//
// Makes no changes — only reports.
//
// Usage:
//   node scripts/checkDuplicateRules.js <companyId>
//   node scripts/checkDuplicateRules.js --all
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }

  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage:\n  node scripts/checkDuplicateRules.js <companyId>\n  node scripts/checkDuplicateRules.js --all");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const Company     = require("../models/Company");
  const NurtureRule = require("../models/NurtureRule");

  let companyIds;
  if (arg === "--all") {
    const companies = await Company.find({}).select("_id").lean();
    companyIds = companies.map((c) => String(c._id));
  } else {
    companyIds = [arg];
  }

  let issuesFound = 0;

  for (const companyId of companyIds) {
    const company = await Company.findById(companyId).select("name").lean();
    const label = company ? `"${company.name}" (${companyId})` : companyId;

    const rules = await NurtureRule.find({ company: companyId, enabled: true })
      .select("name action.whatsapp.statusStage action.whatsapp.autoResolveTemplate action.whatsapp.funnelStage createdAt")
      .lean();

    if (!rules.length) continue;

    // Group enabled rules by statusStage
    const byStage = new Map();
    for (const rule of rules) {
      const stage = rule.action?.whatsapp?.statusStage || "(none)";
      if (!byStage.has(stage)) byStage.set(stage, []);
      byStage.get(stage).push(rule);
    }

    const duplicates = [...byStage.entries()].filter(([, list]) => list.length > 1);

    if (duplicates.length) {
      issuesFound++;
      console.log(`\n${"─".repeat(70)}`);
      console.log(`⚠️  ${label} — ${duplicates.length} status stage(s) with multiple enabled rules:\n`);
      for (const [stage, list] of duplicates) {
        console.log(`   Status "${stage}" — ${list.length} enabled rules targeting it:`);
        for (const r of list) {
          console.log(
            `     - "${r.name}" (id: ${r._id}) — autoResolve=${!!r.action?.whatsapp?.autoResolveTemplate}, ` +
            `funnelStage="${r.action?.whatsapp?.funnelStage || "(none)"}", created=${r.createdAt?.toISOString?.() || "?"}`
          );
        }
        console.log(
          `     → Every lead in status "${stage}" is evaluated by ALL ${list.length} of these rules ` +
          `independently, producing ${list.length}x the log rows (sent or skipped) per lead per run. ` +
          `If this isn't a deliberate multi-touch sequence, disable or delete all but one.`
        );
      }
    }
  }

  console.log(
    issuesFound
      ? `\n\n❌ Found duplicate-stage rules in ${issuesFound} compan${issuesFound === 1 ? "y" : "ies"}. Nothing was changed — review and disable/delete the extras manually.`
      : `\n✅ No company has more than one enabled rule per status stage.`
  );

  await mongoose.disconnect();
}

run().catch((e) => { console.error("Script failed:", e); process.exit(1); });
