    // scripts/migrateQualificationScoring.js
    //
    // One-off migration for the new qualification scoring model:
    //   • Each question's options must total exactly 100 points.
    //   • Maximum Score = number of questions × 100.
    //   • Percentage = (leadScore / maxScore) × 100.
    //
    // What it does:
    //   1. For every MetaQualification rule-set:
    //        - recomputes maxScore (= questions × 100)
    //        - sets optionsValid = (every question totals exactly 100)
    //        - logs an admin warning for any campaign that needs correction
    //   2. For every scored Lead (leadScore != null):
    //        - backfills maxScore from its ad set's rule-set (questions × 100)
    //        - backfills qualificationPercentage = (leadScore / maxScore) × 100
    //
    // Usage:
    //   node scripts/migrateQualificationScoring.js
    //
    // Safe to re-run (idempotent).

    require("dotenv").config();
    const mongoose = require("mongoose");

    const MetaQualification = require("../models/MetaQualification");
    const MetaConfig        = require("../models/MetaConfig");
    const Lead              = require("../models/Leads");

    const POINTS_PER_QUESTION = 100;

    async function run() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;
    if (!uri) {
        console.error("✖ No MONGO_URI / MONGODB_URI env var found. Aborting.");
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log("✓ Connected to MongoDB\n");

    // ── 1. Rule-sets ──────────────────────────────────────────────────────────
    const quals = await MetaQualification.find({});
    console.log(`Found ${quals.length} qualification rule-set(s).\n`);

    const warnings = [];
    for (const q of quals) {
        const { valid, maxScore, errors } =
        MetaQualification.validateRules(q.rules || []);

        q.maxScore     = maxScore;
        q.optionsValid = valid;
        await q.save();

        const tag = valid ? "OK " : "⚠ NEEDS CORRECTION";
        console.log(
        `  [${tag}] "${q.adSetName || q.adSetId}" — ${(q.rules || []).length} question(s), maxScore=${maxScore}`
        );
        if (!valid) {
        errors.forEach((e) =>
            console.log(`        • "${e.questionLabel}" totals ${e.total} (must be 100)`)
        );
        warnings.push({
            adSetId:   String(q.adSetId),
            adSetName: q.adSetName,
            errors,
        });
        }
    }

    // ── 2. Leads ────────────────────────────────────────────────────────────--
    // Build a lookup: adSetName → maxScore (questions × 100) for quick backfill.
    // Leads store adSetName, and MetaQualification stores adSetName too.
    const maxByAdSetName = {};
    quals.forEach((q) => {
        if (q.adSetName) {
        maxByAdSetName[q.adSetName] = (q.rules || []).length * POINTS_PER_QUESTION;
        }
    });

    const scoredLeads = await Lead.find({ leadScore: { $ne: null } });
    console.log(`\nFound ${scoredLeads.length} scored lead(s) to backfill.`);

    let updated = 0;
    for (const lead of scoredLeads) {
        let maxScore = lead.maxScore;

        // Prefer a fresh value from the matching rule-set when available.
        if (lead.adSetName && maxByAdSetName[lead.adSetName] != null) {
        maxScore = maxByAdSetName[lead.adSetName];
        }

        // Fall back: infer from the saved breakdown (one entry per question × 100).
        if ((maxScore == null || maxScore === 0) && Array.isArray(lead.qualificationBreakdown)) {
        maxScore = lead.qualificationBreakdown.length * POINTS_PER_QUESTION;
        }

        if (maxScore == null || maxScore === 0) continue; // nothing to compute against

        const pct = Math.round((lead.leadScore / maxScore) * 10000) / 100;

        const needsUpdate =
        lead.maxScore !== maxScore || lead.qualificationPercentage !== pct;

        if (needsUpdate) {
        lead.maxScore = maxScore;
        lead.qualificationPercentage = pct;
        await lead.save();
        updated++;
        }
    }
    console.log(`Backfilled maxScore / qualificationPercentage on ${updated} lead(s).`);

    // ── Summary ────────────────────────────────────────────────────────────--
    console.log("\n──────────── SUMMARY ────────────");
    console.log(`Rule-sets processed : ${quals.length}`);
    console.log(`Leads updated       : ${updated}`);
    if (warnings.length) {
        console.log(`\n⚠ ${warnings.length} campaign(s) require admin correction before activation:`);
        warnings.forEach((w) =>
        console.log(`   - ${w.adSetName || w.adSetId} (${w.errors.length} invalid question(s))`)
        );
        console.log(
        "\nOpen each flagged ad set's Qualification rules and adjust option points so every question totals exactly 100, then save."
        );
    } else {
        console.log("\nAll campaigns are valid (every question totals 100). ✓");
    }

    await mongoose.disconnect();
    console.log("\n✓ Done.");
    }

    run().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
    });