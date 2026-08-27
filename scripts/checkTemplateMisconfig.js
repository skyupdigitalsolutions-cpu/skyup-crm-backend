// scripts/checkTemplateMisconfig.js
// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY health check — scans every company for the two misconfigurations
// that caused an industry-specific template to be sent to the wrong (or
// untagged) leads:
//
//   1. A "fixed, sent-to-everyone" template setting (Auto-Template,
//      Interested-Blast, or Follow-up Reminder) configured with a name from
//      the industry×service auto-resolve library (…_stage_vN) instead of a
//      genuinely generic template. This field has no per-lead industry
//      check by design, so a mismatched name here sends that ONE vertical's
//      message to every lead, regardless of their real industry/service.
//      (services/autoTemplateService.js now blocks the actual send at
//      runtime, and controllers/adminController.js now rejects saving a new
//      one — but neither retroactively fixes a value already stored before
//      those guards existed. That's what this script finds.)
//
//   2. A NurtureRule with autoResolveTemplate=true but an empty funnelStage
//      — which used to silently fall through to a static templateName with
//      no industry/service check at all (jobs/nurtureSequenceJob.js fixed
//      the runtime behavior; this flags any rule still misconfigured that
//      way so it can be corrected in the Nurture Sequence Builder).
//
// Makes NO changes — only reports. Safe to run anytime, as often as you like.
//
// Usage:
//   node scripts/checkTemplateMisconfig.js
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ MONGO_URI not set"); process.exit(1); }

  await mongoose.connect(uri);
  console.log("🔍 Scanning for misconfigured auto-send / nurture templates...\n");

  const Company     = require("../models/Company");
  const NurtureRule = require("../models/NurtureRule");
  const { looksLikeAutoResolvedName } = require("../utils/templateNameResolver");

  let issuesFound = 0;

  // ── 1. Fixed, sent-to-everyone template settings ────────────────────────
  const companies = await Company.find({})
    .select("name autoTemplate interestedBlast followUpReminder")
    .lean();

  const FIELDS_TO_CHECK = [
    { path: "autoTemplate",     label: "Auto-Template (new lead)" },
    { path: "interestedBlast",  label: "Interested-Blast" },
    { path: "followUpReminder", label: "Follow-up Reminder" },
  ];

  for (const company of companies) {
    for (const { path, label } of FIELDS_TO_CHECK) {
      const templateName = company[path]?.whatsapp?.templateName;
      const enabled      = company[path]?.whatsapp?.enabled;
      if (!templateName) continue;

      if (looksLikeAutoResolvedName(templateName)) {
        issuesFound++;
        console.log(
          `⚠️  [${enabled ? "ENABLED " : "disabled"}] "${company.name}" (${company._id})\n` +
          `    ${label} → templateName = "${templateName}"\n` +
          `    This looks industry-specific, not generic. Every lead through this ` +
          `setting${enabled ? " is CURRENTLY receiving" : " would receive, if enabled,"} ` +
          `this ONE vertical's message regardless of their own industry/service.\n`
        );
      }
    }
  }

  // ── 2. Nurture rules with autoResolveTemplate=true but empty funnelStage ─
  const rules = await NurtureRule.find({ "action.whatsapp.autoResolveTemplate": true })
    .select("name company action.whatsapp.funnelStage action.whatsapp.templateName enabled")
    .lean();

  for (const rule of rules) {
    const wa = rule.action?.whatsapp || {};
    if (!wa.funnelStage) {
      issuesFound++;
      console.log(
        `⚠️  [${rule.enabled ? "ENABLED " : "disabled"}] Rule "${rule.name}" (company ${rule.company})\n` +
        `    autoResolveTemplate=true but funnelStage is EMPTY.\n` +
        `    Static fallback templateName on this rule = "${wa.templateName || "(none set)"}"${
          wa.templateName ? " — this is what actually gets sent, to every matching lead, regardless of industry." : ""
        }\n` +
        `    Fix: open this rule in the Nurture Sequence Builder and set its Funnel Stage.\n`
      );
    }
  }

  console.log(
    issuesFound
      ? `\n❌ Found ${issuesFound} issue(s) above. None of these were modified — fix each one manually in the relevant settings screen.`
      : `\n✅ No misconfigured templates found across ${companies.length} compan${companies.length === 1 ? "y" : "ies"} and ${rules.length} auto-resolve rule(s).`
  );

  await mongoose.disconnect();
}

run().catch((e) => { console.error("Script failed:", e); process.exit(1); });
