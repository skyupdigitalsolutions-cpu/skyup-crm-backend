// scripts/checkIndexes.js
// ─────────────────────────────────────────────────────────────────────────────
// Shows, for every model, which indexes the CODE declares and which ones
// actually EXIST in MongoDB — and optionally builds the missing ones.
//
//   node scripts/checkIndexes.js            → report only (changes nothing)
//   node scripts/checkIndexes.js --create   → also build the missing indexes
//
// Safe: --create only ADDS indexes (Model.createIndexes). It never drops one.
// Index builds run in the background on Atlas; the app keeps working.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const CREATE = process.argv.includes('--create');
const keyOf = (k) => JSON.stringify(k);

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  console.log(`Connected to ${mongoose.connection.name}\n`);

  // Load every model file so all schemas are registered.
  const dir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js')) { try { require(path.join(dir, f)); } catch (e) { console.warn(`! could not load ${f}: ${e.message}`); } }
  }

  let totalMissing = 0, totalOk = 0;
  const names = mongoose.modelNames().sort();
  for (const name of names) {
    const Model = mongoose.model(name);
    const wanted = Model.schema.indexes(); // [[keys, options], ...]
    let existing = [];
    try { existing = await Model.collection.indexes(); } catch { existing = []; } // collection may not exist yet
    const have = new Set(existing.map((i) => keyOf(i.key)));

    const missing = wanted.filter(([keys]) => !have.has(keyOf(keys)));
    totalOk += wanted.length - missing.length;
    totalMissing += missing.length;

    const docs = await Model.estimatedDocumentCount().catch(() => 0);
    const status = missing.length ? `❌ ${missing.length} missing` : '✅ all present';
    console.log(`${name.padEnd(28)} docs=${String(docs).padEnd(8)} declared=${String(wanted.length).padEnd(3)} ${status}`);
    for (const [keys, opts] of missing) {
      console.log(`     missing: ${keyOf(keys)}${opts && opts.unique ? ' (unique)' : ''}`);
    }

    if (CREATE && missing.length) {
      try {
        await Model.createIndexes();
        console.log('     → built ✅');
      } catch (e) {
        console.log(`     → build failed: ${e.message}`);
        if (/duplicate key/i.test(e.message)) console.log('       (a UNIQUE index cannot be built while duplicate rows exist — clean them first)');
      }
    }
  }

  console.log(`\nTotal: ${totalOk} present, ${totalMissing} missing.`);
  if (totalMissing && !CREATE) console.log('Run again with --create to build the missing ones.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
