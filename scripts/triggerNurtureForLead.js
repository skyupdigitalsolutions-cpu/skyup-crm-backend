// scripts/triggerNurtureForLead.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME script — fires the nurture sequence for ONE specific lead only.
// Does NOT touch any other lead. Safe to run multiple times (dry-run default).
//
// Usage:
//   node scripts/triggerNurtureForLead.js              ← dry-run (no send)
//   node scripts/triggerNurtureForLead.js --send       ← actually sends WhatsApp
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");

// ── TARGET LEAD (hardcoded for this one-time test) ────────────────────────────
const TARGET_LEAD_ID = "6a66e3d8c0d24a71800e1f0a"; // srinivas · 9538281101
const SEND           = process.argv.includes("--send");

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`\n🎯 Targeted nurture test`);
  console.log(`   Lead  : ${TARGET_LEAD_ID}`);
  console.log(`   Mode  : ${SEND ? "SEND (real WhatsApp!)" : "DRY-RUN (no send)"}\n`);

  const Lead        = require("../models/Leads");
  const NurtureRule = require("../models/NurtureRule");
  const { resolveForLead, canResolve } = require("../utils/templateNameResolver");
  const { sendAutoWhatsApp }           = require("../services/autoTemplateService");

  // ── 1. Load the lead ─────────────────────────────────────────────────────────
  const lead = await Lead.findById(TARGET_LEAD_ID)
    .select("name mobile company status temperature source industry service businessName nurtureSent date callHistory importedViaCsv addedManually user")
    .lean();

  if (!lead) {
    console.error(`❌ Lead ${TARGET_LEAD_ID} not found.`);
    await mongoose.disconnect(); process.exit(1);
  }

  console.log(`Lead details:`);
  console.log(`  Name        : ${lead.name}`);
  console.log(`  Mobile      : ${lead.mobile}`);
  console.log(`  Status      : ${lead.status}`);
  console.log(`  Industry    : ${lead.industry || "(not set)"}`);
  console.log(`  Service     : ${lead.service  || "(not set)"}`);
  console.log(`  BusinessName: ${lead.businessName || "(not set — will use 'your business')"}`);

  if (!canResolve(lead)) {
    console.error(`\n❌ Cannot resolve template — lead is missing industry or service.`);
    await mongoose.disconnect(); process.exit(1);
  }

  // ── 2. Load enabled rules ─────────────────────────────────────────────────────
  const rules = await NurtureRule.find({ enabled: true }).lean();
  if (!rules.length) {
    console.error(`\n❌ No enabled nurture rules found. Create one in Lead Nurture first.`);
    await mongoose.disconnect(); process.exit(1);
  }

  console.log(`\nEnabled rules: ${rules.length}`);
  for (const r of rules) {
    const wa = r.action?.whatsapp || {};
    console.log(`  · "${r.name}" — stage=${wa.funnelStage || "(none)"} auto=${wa.autoResolveTemplate ? "YES" : "no"}`);
  }

  // ── 3. Preview what each rule would send ──────────────────────────────────────
  console.log(`\n── Template resolution preview ──────────────────────────`);
  const toSend = [];

  for (const rule of rules) {
    const wa = rule.action?.whatsapp || {};
    if (!wa.enabled) { console.log(`  ⏭  "${rule.name}" — WhatsApp not enabled on rule`); continue; }
    if (!wa.autoResolveTemplate || !wa.funnelStage) { console.log(`  ⏭  "${rule.name}" — auto-resolve not enabled`); continue; }

    const count    = Math.max(1, Number(wa.variationCount) || 5);
    const variation = 1; // always use V1 for test
    const tplName  = resolveForLead(lead, wa.funnelStage, variation);

    console.log(`\n  Rule: "${rule.name}"`);
    console.log(`    Template  : ${tplName}`);
    console.log(`    {{1}}     : ${lead.name}`);
    console.log(`    {{2}}     : ${lead.businessName || "your business"}`);
    console.log(`    To        : ${lead.mobile}`);

    toSend.push({ rule, tplName, variation });
  }

  if (!toSend.length) {
    console.log(`\n⚠  No rules are configured for auto-resolve. Nothing to send.`);
    await mongoose.disconnect(); return;
  }

  // ── 4. Send (if --send flag) ──────────────────────────────────────────────────
  if (!SEND) {
    console.log(`\n── DRY-RUN complete — no messages sent ──`);
    console.log(`   Re-run with --send to fire:\n   node scripts/triggerNurtureForLead.js --send`);
    await mongoose.disconnect(); return;
  }

  console.log(`\n── Sending ──────────────────────────────────────────────`);
  for (const { rule, tplName } of toSend) {
    const wa = rule.action?.whatsapp || {};
    try {
      console.log(`  → Sending "${tplName}" to ${lead.mobile}...`);
      const result = await sendAutoWhatsApp({
        companyId:        lead.company,
        lead,
        whatsappSettings: { ...wa, templateName: tplName },
      });
      console.log(`  ✅ Result:`, JSON.stringify(result).slice(0, 200));
    } catch (err) {
      console.error(`  ❌ Failed:`, err.message);
    }
  }

  console.log(`\n✅ Done. Check WhatsApp on 9538281101.`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error("Script failed:", e); process.exit(1); });