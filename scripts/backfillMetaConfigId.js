/**
 * scripts/backfillMetaConfigId.js
 *
 * Safe, idempotent backfill: stamps legacy Meta leads (metaConfigId == null)
 * with the correct metaConfigId + adSetName so the Campaigns page can count
 * leads PER AD SET instead of lumping them all onto the bare campaign card.
 *
 * WHY THIS EXISTS
 *   New Meta webhook leads already carry metaConfigId + adSetName
 *   (see utils/metaHelper.mapToLeadSchema). Leads created before those fields
 *   existed have metaConfigId == null, so the per-ad-set count query can't tell
 *   which ad set they belong to and they all fall onto the bare-campaign card.
 *   This script repairs that — but ONLY when the match is unambiguous.
 *
 * MATCHING STRATEGY (per company, source == "Meta", metaConfigId == null)
 *   For each legacy lead we look for the MetaConfig it belongs to:
 *     1. If the lead already has a non-empty adSetName, match on
 *        (campaignName == lead.campaign  AND  adSetName == lead.adSetName).
 *     2. Otherwise match on campaignName == lead.campaign only.
 *   If EXACTLY ONE config matches, we stamp the lead.
 *   If ZERO or MORE THAN ONE config matches, the lead is left untouched and
 *   reported as "ambiguous" — we never guess.
 *
 * USAGE
 *   Dry-run (default — writes nothing, just reports):
 *     node scripts/backfillMetaConfigId.js
 *   Apply:
 *     node scripts/backfillMetaConfigId.js --apply
 *   Limit to one company:
 *     node scripts/backfillMetaConfigId.js --apply --company=<companyId>
 *
 * SAFETY
 *   • Idempotent — only touches leads with metaConfigId == null.
 *   • Never overwrites an existing metaConfigId.
 *   • Ambiguous matches are skipped and logged, not guessed.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY      = process.argv.includes("--apply");
const COMPANY_ARG = (process.argv.find((a) => a.startsWith("--company=")) || "").split("=")[1] || null;

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
  if (!uri) {
    console.error("❌ No Mongo connection string found (MONGO_URI / MONGODB_URI / DB_URI).");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`✅ Connected. Mode: ${APPLY ? "APPLY (will write)" : "DRY-RUN (no writes)"}`);

  const Lead       = require("../models/Leads");
  const MetaConfig = require("../models/MetaConfig");

  const leadFilter = {
    source: "Meta",
    $or: [{ metaConfigId: null }, { metaConfigId: { $exists: false } }],
  };
  if (COMPANY_ARG) leadFilter.company = COMPANY_ARG;

  const legacyLeads = await Lead.find(leadFilter)
    .select("_id campaign adSetName company")
    .lean();

  console.log(`🔎 Found ${legacyLeads.length} legacy Meta lead(s) with no metaConfigId.`);

  // Cache configs per company to avoid repeated queries.
  const configCache = new Map(); // companyId -> [configs]
  const getConfigs = async (companyId) => {
    const key = String(companyId);
    if (configCache.has(key)) return configCache.get(key);
    const configs = await MetaConfig.find({ company: companyId })
      .select("_id campaignName adSetName")
      .lean();
    configCache.set(key, configs);
    return configs;
  };

  let matched = 0;
  let ambiguous = 0;
  let noCampaign = 0;
  const ambiguousReport = [];
  const ops = [];

  for (const lead of legacyLeads) {
    if (!lead.campaign) { noCampaign++; continue; }

    const configs = await getConfigs(lead.company);
    const leadAdSet = (lead.adSetName || "").trim();

    let candidates;
    if (leadAdSet) {
      candidates = configs.filter(
        (c) =>
          (c.campaignName || "") === lead.campaign &&
          (c.adSetName || "").trim() === leadAdSet,
      );
    } else {
      candidates = configs.filter((c) => (c.campaignName || "") === lead.campaign);
    }

    if (candidates.length === 1) {
      const cfg = candidates[0];
      matched++;
      ops.push({
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: {
              metaConfigId: cfg._id,
              adSetName: lead.adSetName || cfg.adSetName || "",
            },
          },
        },
      });
    } else {
      ambiguous++;
      ambiguousReport.push({
        leadId: String(lead._id),
        campaign: lead.campaign,
        adSetName: leadAdSet || "(none)",
        matchingConfigs: candidates.length,
      });
    }
  }

  console.log(`\n── Summary ──────────────────────────────────────`);
  console.log(`  Unambiguous matches (will stamp): ${matched}`);
  console.log(`  Ambiguous (skipped):              ${ambiguous}`);
  console.log(`  No campaign field (skipped):      ${noCampaign}`);

  if (ambiguousReport.length) {
    console.log(`\n  Ambiguous leads (0 or >1 matching config) — review manually:`);
    ambiguousReport.slice(0, 50).forEach((r) =>
      console.log(`    • lead ${r.leadId} | campaign="${r.campaign}" | adSet="${r.adSetName}" | configs=${r.matchingConfigs}`),
    );
    if (ambiguousReport.length > 50)
      console.log(`    …and ${ambiguousReport.length - 50} more.`);
  }

  if (APPLY && ops.length) {
    const result = await Lead.bulkWrite(ops, { ordered: false });
    console.log(`\n✅ Applied. Modified ${result.modifiedCount} lead(s).`);
  } else if (!APPLY) {
    console.log(`\nℹ Dry-run only. Re-run with --apply to write ${ops.length} update(s).`);
  } else {
    console.log(`\nℹ Nothing to apply.`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("❌ Migration error:", err);
  process.exit(1);
});
