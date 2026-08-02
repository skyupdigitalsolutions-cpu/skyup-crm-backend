// scripts/clearPlainPasswords.js — NEW FILE
// ─────────────────────────────────────────────────────────────────────────────
// SECURITY FIX — one-time cleanup.
//
// Admin.plainPassword and User.plainPassword used to store every account's
// actual password in plaintext (for a "super_admin view credentials"
// feature). That's been removed from all code paths (see models/Admin.js,
// models/Users.js, controllers/adminController.js, superAdminController.js,
// forgotPasswordController.js) and replaced with a one-time "Reset Password"
// action instead.
//
// This script clears out whatever plaintext values are ALREADY sitting in
// the database from before that fix — run it once, after deploying the code
// changes above.
//
// Usage:
//   MONGO_URI="mongodb+srv://..." node scripts/clearPlainPasswords.js
//   (or relies on .env if MONGO_URI/MONGODB_URI is already set there)
//
// This does NOT change anyone's actual login password (the hashed `password`
// field is untouched) — it only removes the plaintext copy. No one is locked
// out by running this.
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;

async function main() {
  if (!MONGO_URI) {
    console.error("❌ No Mongo connection string found (MONGO_URI / MONGODB_URI / DB_URI).");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const Admin = require("../models/Admin");
  const User  = require("../models/Users");

  const adminResult = await Admin.updateMany(
    { plainPassword: { $ne: null } },
    { $set: { plainPassword: null } }
  );
  console.log(`✅ Admin: cleared plainPassword on ${adminResult.modifiedCount} document(s)`);

  const userResult = await User.updateMany(
    { plainPassword: { $ne: null } },
    { $set: { plainPassword: null } }
  );
  console.log(`✅ User: cleared plainPassword on ${userResult.modifiedCount} document(s)`);

  console.log("\nDone. No login passwords were changed — only the plaintext copy was removed.");
  console.log("Recommended next step: once you've confirmed the app works fine without it,");
  console.log("drop the plainPassword field from models/Admin.js and models/Users.js entirely.");

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});