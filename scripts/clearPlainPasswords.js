#!/usr/bin/env node
// scripts/clearPlainPasswords.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE-TIME SECURITY MIGRATION: clears plainPassword from all Admin and User
// documents in MongoDB. This field stored plaintext credentials from older
// versions of the admin creation flow. It is now removed from all API
// responses and should also be removed from the database.
//
// SAFE TO RUN: only updates documents where plainPassword is not null.
//              Does not delete any documents or touch any other fields.
//
// HOW TO RUN:
//   NODE_ENV=production MONGODB_URI=<your-uri> node scripts/clearPlainPasswords.js
//
// EXPECTED OUTPUT:
//   ✅ Admins cleared: N
//   ✅ Users cleared:  N
//   Done. No plaintext passwords remain in the database.
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI env var is not set.");
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connected to MongoDB");

  const db = mongoose.connection.db;

  // ── Clear from admins collection ───────────────────────────────────────────
  const adminResult = await db.collection("admins").updateMany(
    { plainPassword: { $ne: null, $exists: true } },
    { $set: { plainPassword: null } }
  );
  console.log(`✅ Admins cleared: ${adminResult.modifiedCount}`);

  // ── Clear from users collection ────────────────────────────────────────────
  const userResult = await db.collection("users").updateMany(
    { plainPassword: { $ne: null, $exists: true } },
    { $set: { plainPassword: null } }
  );
  console.log(`✅ Users cleared:  ${userResult.modifiedCount}`);

  // ── Verification: confirm no documents still have a non-null value ─────────
  const adminRemaining = await db.collection("admins").countDocuments({ plainPassword: { $ne: null } });
  const userRemaining  = await db.collection("users").countDocuments({ plainPassword: { $ne: null } });

  if (adminRemaining > 0 || userRemaining > 0) {
    console.error(`❌ WARNING: ${adminRemaining} admins and ${userRemaining} users still have plainPassword set.`);
    process.exit(1);
  }

  console.log("Done. No plaintext passwords remain in the database.");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
