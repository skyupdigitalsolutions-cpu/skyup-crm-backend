/**
 * scripts/migrateNormalizedPhones.js
 *
 * Safe, idempotent backfill script.
 * Sets normalizedPhone on every Lead that doesn't already have it.
 *
 * USAGE:
 *   Dry-run (default — shows what will happen, writes nothing):
 *     node scripts/migrateNormalizedPhones.js
 *
 *   Apply to database:
 *     node scripts/migrateNormalizedPhones.js --apply
 *
 *   Limit batch size (default 500):
 *     node scripts/migrateNormalizedPhones.js --apply --batch=200
 *
 * OUTPUT:
 *   - Console progress log
 *   - duplicates-report.csv (in project root) listing leads that would
 *     conflict with the unique index — review before deploying the index!
 *
 * DEPLOY ORDER:
 *   1. Deploy updated code (index definition in Leads.js) — index is partial
 *      so it only enforces uniqueness on leads WHERE normalizedPhone exists.
 *      Existing leads without the field are unaffected.
 *   2. Run this script in dry-run: node scripts/migrateNormalizedPhones.js
 *   3. Review duplicates-report.csv — manually merge or archive duplicates.
 *   4. Run with --apply during low traffic.
 *   5. Index now enforces uniqueness across all records.
 */

require('dotenv').config();
const mongoose  = require('mongoose');
const fs        = require('fs');
const path      = require('path');

const { normalizePhone } = require('../utils/normalizePhone');

const APPLY    = process.argv.includes('--apply');
const BATCH_ARG = process.argv.find(a => a.startsWith('--batch='));
const BATCH_SIZE = BATCH_ARG ? parseInt(BATCH_ARG.split('=')[1]) : 500;

// ── Minimal Lead schema for this script ──────────────────────────────────────
const leadSchema = new mongoose.Schema({
  mobile:          String,
  normalizedPhone: String,
  name:            String,
  company:         mongoose.Schema.Types.ObjectId,
  status:          String,
  createdAt:       Date,
}, { strict: false, collection: 'leads' });

const Lead = mongoose.model('Lead', leadSchema);

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');
  console.log(`Mode: ${APPLY ? '🟠 APPLY (writing to DB)' : '🟢 DRY-RUN (no writes)'}`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  // ── Step 1: Count leads missing normalizedPhone ───────────────────────────
  const total = await Lead.countDocuments({
    $or: [{ normalizedPhone: { $exists: false } }, { normalizedPhone: null }],
  });
  console.log(`\nLeads missing normalizedPhone: ${total}`);
  if (total === 0) {
    console.log('Nothing to migrate. Exiting.');
    await mongoose.disconnect();
    return;
  }

  // ── Step 2: Process in batches ────────────────────────────────────────────
  let processed = 0, updated = 0, skippedInvalid = 0;
  const duplicateGroups = [];

  let cursor = Lead.find({
    $or: [{ normalizedPhone: { $exists: false } }, { normalizedPhone: null }],
  }, { mobile: 1, name: 1, company: 1, status: 1, createdAt: 1 }).lean().cursor();

  const batch = [];

  const processBatch = async () => {
    if (!batch.length) return;

    // Group by company+normalizedPhone to detect duplicates
    const seen = new Map(); // key: "companyId|normPhone" → first lead
    const ops  = [];

    for (const lead of batch) {
      const norm = normalizePhone(lead.mobile);
      if (!norm) {
        skippedInvalid++;
        if (APPLY) {
          // Set to null explicitly so we don't re-process on next run
          ops.push({ updateOne: { filter: { _id: lead._id }, update: { $set: { normalizedPhone: null } } } });
        }
        continue;
      }

      const key = `${lead.company}|${norm}`;
      if (seen.has(key)) {
        duplicateGroups.push({ existing: seen.get(key), duplicate: lead, normalizedPhone: norm });
      } else {
        seen.set(key, lead);
        if (APPLY) {
          ops.push({ updateOne: { filter: { _id: lead._id }, update: { $set: { normalizedPhone: norm } } } });
          updated++;
        } else {
          updated++; // count as "would update"
        }
      }
    }

    if (APPLY && ops.length) {
      await Lead.bulkWrite(ops, { ordered: false });
    }

    processed += batch.length;
    batch.length = 0;

    const pct = Math.round((processed / total) * 100);
    process.stdout.write(`\r  Progress: ${processed}/${total} (${pct}%)  duplicates found: ${duplicateGroups.length}`);
  };

  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= BATCH_SIZE) await processBatch();
  }
  await processBatch(); // flush remaining

  console.log('\n');

  // ── Step 3: Write duplicates report ──────────────────────────────────────
  const reportPath = path.join(process.cwd(), 'duplicates-report.csv');
  if (duplicateGroups.length > 0) {
    const header = 'normalizedPhone,keepId,keepName,keepStatus,keepCreatedAt,dupId,dupName,dupStatus,dupCreatedAt\n';
    const rows = duplicateGroups.map(g =>
      [
        g.normalizedPhone,
        g.existing._id, g.existing.name, g.existing.status, g.existing.createdAt,
        g.duplicate._id, g.duplicate.name, g.duplicate.status, g.duplicate.createdAt,
      ].join(',')
    ).join('\n');
    fs.writeFileSync(reportPath, header + rows);
    console.log(`⚠️  Found ${duplicateGroups.length} duplicate phone numbers.`);
    console.log(`   Report written to: ${reportPath}`);
    console.log('   Review and merge/archive duplicates BEFORE deploying the unique index.');
  } else {
    console.log('✅ No duplicate phone numbers found — safe to deploy the unique index.');
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n── Summary ──────────────────────────────────────────────────────');
  console.log(`  Total leads processed : ${processed}`);
  console.log(`  ${APPLY ? 'Updated' : 'Would update'} with normalizedPhone : ${updated}`);
  console.log(`  Skipped (invalid/landline) : ${skippedInvalid}`);
  console.log(`  Duplicate groups found : ${duplicateGroups.length}`);
  if (!APPLY) {
    console.log('\n  👉 Re-run with --apply to write changes to the database.');
  }

  await mongoose.disconnect();
  console.log('✅ Done');
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
