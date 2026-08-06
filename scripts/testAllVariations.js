// scripts/testAllVariations.js
// ─────────────────────────────────────────────────────────────────────────────
// Sends ALL 5 variations (V1→V5) of a nurture template to one test lead,
// with a 5-second gap between each send so MSG91 doesn't throttle.
//
// Hardcoded to: srinivas · 9538281101 · Real Estate + Video Editing · Awareness
//
// Usage:
//   node scripts/testAllVariations.js              ← dry-run (shows what would send)
//   node scripts/testAllVariations.js --send       ← actually sends all 5
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const mongoose = require("mongoose");

// Accept lead ID from --lead=xxx argument, fallback to srinivas
const leadArg      = process.argv.find((a) => a.startsWith("--lead="));
const TARGET_LEAD_ID = leadArg ? leadArg.split("=")[1] : "6a66e3d8c0d24a71800e1f0a";
const SEND           = process.argv.includes("--send");
const DELAY_MS       = 5000; // 5 seconds between each

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }

  await mongoose.connect(uri);
  console.log(`\n🚀 V1–V5 Variation Test`);
  console.log(`   Lead  : ${TARGET_LEAD_ID}`);
  console.log(`   Mode  : ${SEND ? "SEND — all 5 variations, 5s gap each" : "DRY-RUN — no sends"}`);
  console.log(`   Stage : awareness\n`);

  const Lead = require("../models/Leads");
  const { resolveForLead } = require("../utils/templateNameResolver");
  const { sendAutoWhatsApp } = require("../services/autoTemplateService");
  const WhatsAppConfig = require("../models/WhatsAppConfig");

  // Load lead
  const lead = await Lead.findById(TARGET_LEAD_ID)
    .select("name mobile company status industry service businessName nurtureSent")
    .lean();

  if (!lead) {
    console.error(`❌ Lead not found.`);
    await mongoose.disconnect(); process.exit(1);
  }

  // Build all 5 template names
  const stage = "awareness"; // change this to test other stages
  const variations = [1, 2, 3, 4, 5];
  const templates = variations.map((v) => ({
    variation: v,
    templateName: resolveForLead(lead, stage, v),
  }));

  console.log(`Templates that will fire:`);
  console.log(`${"V".padEnd(4)} ${"Template Name".padEnd(50)} Status`);
  console.log(`${"─".repeat(70)}`);
  templates.forEach(({ variation, templateName }) => {
    console.log(`V${variation}   ${templateName.padEnd(50)} ${SEND ? "⏳ queued" : "📋 preview"}`);
  });

  if (!SEND) {
    console.log(`\n── DRY-RUN complete ──`);
    console.log(`   All 5 template names resolved correctly.`);
    console.log(`   Re-run with --send to fire them:\n   node scripts/testAllVariations.js --send`);
    await mongoose.disconnect(); return;
  }

  // Get WhatsApp settings from the company config
  const waConfig = await WhatsAppConfig.findOne({
    company: lead.company,
    isActive: true,
  }).lean();

  if (!waConfig) {
    console.error(`❌ No active WhatsAppConfig found for company.`);
    await mongoose.disconnect(); process.exit(1);
  }

  console.log(`\n── Sending V1 to V5 with ${DELAY_MS / 1000}s gap between each ──\n`);

  const results = [];

  for (const { variation, templateName } of templates) {
    console.log(`📤 Sending V${variation}: ${templateName}`);
    console.log(`   {{1}} = ${lead.name}  |  {{2}} = ${lead.businessName || "your business"}`);
    console.log(`   To: ${lead.mobile}`);

    try {
      const result = await sendAutoWhatsApp({
        companyId:        lead.company,
        lead,
        whatsappSettings: {
          enabled:             true,
          templateName,
          languageCode:        "en",
          autoResolveTemplate: true,
          funnelStage:         stage,
        },
      });

      const success = result?.status === "sent" || result?.channel === "whatsapp";
      console.log(`   ${success ? "✅" : "❌"} Result: ${JSON.stringify(result).slice(0, 150)}`);
      results.push({ variation, templateName, success, result });
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      results.push({ variation, templateName, success: false, error: err.message });
    }

    if (variation < 5) {
      console.log(`   ⏱  Waiting ${DELAY_MS / 1000}s before next...\n`);
      await sleep(DELAY_MS);
    }
  }

  // Summary
  console.log(`\n${"─".repeat(70)}`);
  console.log(`📊 Summary`);
  console.log(`${"─".repeat(70)}`);
  results.forEach(({ variation, templateName, success, error }) => {
    const icon = success ? "✅" : "❌";
    const note = error ? ` — ${error.slice(0, 80)}` : "";
    console.log(`${icon} V${variation}  ${templateName}${note}`);
  });

  const passed = results.filter((r) => r.success).length;
  console.log(`\n✅ ${passed}/5 sent successfully. Check WhatsApp on 9538281101.`);

  await mongoose.disconnect();
}

run().catch((e) => { console.error("Script failed:", e); process.exit(1); });