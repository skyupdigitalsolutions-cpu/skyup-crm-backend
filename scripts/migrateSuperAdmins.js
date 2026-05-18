// scripts/migrateSuperAdmins.js — NEW FILE (run once only!)
// Run: node backend/scripts/migrateSuperAdmins.js
//
// What this does:
//   1. Renames Admin.role "superadmin" → "super_admin" in MongoDB
//   2. Converts the first legacy SuperAdmin document → Developer account
//
// SAFE to run multiple times (idempotent).

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const mongoose   = require("mongoose");
const SuperAdmin = require("../models/SuperAdmin");
const Admin      = require("../models/Admin");
const Developer  = require("../models/Developer");

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  // ── Step 1: Rename Admin.role "superadmin" → "super_admin" ──────────────────
  const renamed = await Admin.updateMany(
    { role: "superadmin" },
    { $set: { role: "super_admin" } }
  );
  console.log(`✅ Renamed ${renamed.modifiedCount} Admin document(s) to role: "super_admin"`);

  // ── Step 2: Convert the first legacy SuperAdmin → Developer account ──────────
  // The legacy SuperAdmin (platform owner) becomes a Developer.
  // New per-company super_admins are Admin documents with role: "super_admin".
  const superAdmins = await SuperAdmin.find().sort({ createdAt: 1 });

  if (superAdmins.length === 0) {
    console.log("ℹ️  No legacy SuperAdmin documents found — skipping Developer creation.");
  } else {
    const [first, ...rest] = superAdmins;

    const devExists = await Developer.findOne({ email: first.email });
    if (devExists) {
      console.log(`ℹ️  Developer account for ${first.email} already exists — skipping.`);
    } else {
      // Insert with the pre-hashed password directly (skip the pre-save bcrypt hook)
      await Developer.collection.insertOne({
        name:      first.name,
        email:     first.email,
        password:  first.password, // already bcrypt-hashed
        role:      "developer",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`✅ Created Developer account: ${first.email}`);
    }

    if (rest.length > 0) {
      console.log(`⚠️  Found ${rest.length} additional SuperAdmin document(s) — review manually:`);
      rest.forEach(s => console.log(`   - ${s.email}`));
    }
  }

  console.log("\n🎉 Migration complete!");
  console.log("   Next: test login with the developer email at /developer/dashboard");
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});