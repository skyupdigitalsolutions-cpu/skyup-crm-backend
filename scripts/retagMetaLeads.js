/**
 * scripts/retagMetaLeads.js
 *
 * Move Meta leads that were attributed to the WRONG ad-set/campaign config
 * (because the Meta webhook fell back to a catch-all config) onto the CORRECT
 * MetaConfig (ad set). Updates campaign, adSetName, metaConfigId and (optionally)
 * formId so the Campaigns page counts them under the right ad-set card.
 *
 * WHY THIS IS NEEDED
 *   In Meta, a lead form belongs to one ad set. The webhook routes by
 *   pageId + form_id. When an ad-set config has no formId saved, the incoming
 *   lead can't be matched to it and falls through to the first no-form config on
 *   the page — so e.g. "AI_cold" leads end up tagged as "skyup_ads".
 *   This script re-attributes those leads to the intended config.
 *
 * SELECT THE LEADS TO MOVE — choose ONE:
 *   --leadIds=<id1,id2,...>         Move these exact lead _ids.
 *   --formId=<metaFormId>           Move all leads whose stored formId matches
 *                                   (only works for leads saved after the formId
 *                                   field was added).
 *   --fromConfig=<configId>         Move all leads currently tagged with this
 *                                   (wrong) metaConfigId. Combine with --campaign
 *                                   to also match legacy leads (metaConfigId null)
 *                                   by campaign name.
 *   --campaign="skyup_ads"          Match legacy leads by campaign name
 *                                   (use together with --fromConfig or alone).
 *
 * TARGET CONFIG (required):
 *   --toConfig=<configId>           The CORRECT MetaConfig (ad set) to move onto.
 *
 * MODES:
 *   (default)   Dry-run — prints what would change, writes nothing.
 *   --apply     Perform the update.
 *
 * EXAMPLES
 *   List configs so you can find the IDs:
 *     node scripts/retagMetaLeads.js --listConfigs
 *
 *   Dry-run: move every lead currently under the skyup_ads config to AI_cold:
 *     node scripts/retagMetaLeads.js --fromConfig=<skyupId> --toConfig=<aiColdId>
 *
 *   Apply it:
 *     node scripts/retagMetaLeads.js --fromConfig=<skyupId> --toConfig=<aiColdId> --apply
 *
 *   Move specific leads:
 *     node scripts/retagMetaLeads.js --leadIds=66f...,66f... --toConfig=<aiColdId> --apply
 */

require("dotenv").config();
const mongoose = require("mongoose");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const flag = (name) => process.argv.includes(`--${name}`);

const APPLY        = flag("apply");
const LIST_CONFIGS = flag("listConfigs");
const LEAD_IDS     = arg("leadIds");
const FORM_ID      = arg("formId");
const FROM_CONFIG  = arg("fromConfig");
const CAMPAIGN     = arg("campaign");
const TO_CONFIG    = arg("toConfig");

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) {
    console.error("❌ No Mongo connection string found (MONGO_URI / MONGODB_URI / DB_URI).");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const Lead       = require("../models/Leads");
  const MetaConfig = require("../models/MetaConfig");

  // ── List configs and exit ──────────────────────────────────────────────────
  if (LIST_CONFIGS) {
    const configs = await MetaConfig.find({})
      .select("_id campaignName adSetName pageId formId company isActive")
      .lean();
    console.log(`\nMetaConfigs (${configs.length}):`);
    for (const c of configs) {
      console.log(
        `  ${c._id} | "${c.campaignName}"${c.adSetName ? ` › "${c.adSetName}"` : ""} | ` +
        `page=${c.pageId} | formId="${c.formId || ""}" | active=${c.isActive}`,
      );
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!TO_CONFIG) {
    console.error("❌ --toConfig=<configId> is required (the correct ad-set config to move leads onto). Run --listConfigs to find IDs.");
    await mongoose.disconnect();
    process.exit(1);
  }

  const target = await MetaConfig.findById(TO_CONFIG).lean();
  if (!target) {
    console.error(`❌ Target config ${TO_CONFIG} not found.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Build the selection filter ──────────────────────────────────────────────
  let filter = { source: "Meta", company: target.company };
  const selectors = [];

  if (LEAD_IDS) {
    const ids = LEAD_IDS.split(",").map((s) => s.trim()).filter(Boolean);
    selectors.push({ _id: { $in: ids } });
  }
  if (FORM_ID) {
    selectors.push({ formId: FORM_ID });
  }
  if (FROM_CONFIG && CAMPAIGN) {
    selectors.push({ $or: [{ metaConfigId: FROM_CONFIG }, { metaConfigId: null, campaign: CAMPAIGN }] });
  } else if (FROM_CONFIG) {
    selectors.push({ metaConfigId: FROM_CONFIG });
  } else if (CAMPAIGN) {
    selectors.push({ campaign: CAMPAIGN });
  }

  if (selectors.length === 0) {
    console.error("❌ No selection criteria given. Use --leadIds, --formId, --fromConfig and/or --campaign.");
    await mongoose.disconnect();
    process.exit(1);
  }
  filter = { ...filter, $and: selectors };

  const leads = await Lead.find(filter)
    .select("_id name mobile campaign adSetName metaConfigId formId")
    .lean();

  console.log(`\nTarget config: "${target.campaignName}"${target.adSetName ? ` › "${target.adSetName}"` : ""} (${target._id})`);
  console.log(`Matched ${leads.length} lead(s) to re-tag:\n`);
  leads.slice(0, 50).forEach((l) =>
    console.log(`  • ${l._id} | ${l.name} | ${l.mobile} | now: campaign="${l.campaign}" adSet="${l.adSetName || ""}" cfg=${l.metaConfigId || "null"}`),
  );
  if (leads.length > 50) console.log(`  …and ${leads.length - 50} more.`);

  const update = {
    $set: {
      campaign:     target.campaignName,
      adSetName:    target.adSetName || "",
      metaConfigId: target._id,
    },
  };
  if (target.formId) update.$set.formId = target.formId;

  if (APPLY && leads.length) {
    const result = await Lead.updateMany(filter, update);
    console.log(`\n✅ Applied. Modified ${result.modifiedCount} lead(s) → "${target.campaignName}${target.adSetName ? " › " + target.adSetName : ""}".`);
  } else if (!APPLY) {
    console.log(`\nℹ Dry-run only. Re-run with --apply to move ${leads.length} lead(s).`);
  } else {
    console.log(`\nℹ Nothing matched — no changes.`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌ retag error:", err);
  process.exit(1);
});
