/**
 * scripts/restoreLeadsFromBackup.js
 * Undo a mergeDuplicateLeads.js run: puts every lead in the backup back
 * exactly as it was before the merge (types preserved via Extended JSON).
 *   node scripts/restoreLeadsFromBackup.js ./duplicate-merge/backup-<timestamp>.json
 * Note: call logs / WhatsApp threads that were re-pointed stay on the survivor.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const { EJSON } = mongoose.mongo.BSON; // same bson version as the driver

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error("Usage: node scripts/restoreLeadsFromBackup.js <backup.json>"); process.exit(1); }
  const docs = EJSON.parse(fs.readFileSync(file, "utf8"), { relaxed: false });
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI);
  const col = mongoose.connection.db.collection("leads");
  // Clear phone keys on the whole set first so restoring never trips the unique index.
  await col.updateMany({ _id: { $in: docs.map((d) => d._id) } }, { $set: { normalizedPhone: null, normalizedSecondaryPhone: null } });
  let ok = 0;
  for (const d of docs) { await col.replaceOne({ _id: d._id }, d); ok++; }
  console.log(`✅ Restored ${ok} leads from ${file}`);
  await mongoose.disconnect();
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
