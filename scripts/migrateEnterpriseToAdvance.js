// scripts/migrateEnterpriseToAdvance.js — NEW FILE
// One-time migration for the plan rename:
//   Basic, Pro, Enterprise  →  Basic, Pro, Advance, Enterprise(custom)
//
// What it does:
//   1. Re-points every company currently on "enterprise" to "advance"
//      (they keep the exact same limits/features — advance IS the old enterprise).
//   2. Renames the existing "enterprise" PlanConfig row to "advance".
//   3. Inserts a fresh custom "enterprise" PlanConfig (Contact us, no price).
//   4. Renames any past Payment rows planId "enterprise" → "advance" so invoice
//      history still resolves (display only; does not change amounts).
//
// SAFE TO RE-RUN: each step checks current state before acting (idempotent).
//
// Usage:
//   node scripts/migrateEnterpriseToAdvance.js
//   node scripts/migrateEnterpriseToAdvance.js --dry-run

require("dotenv").config();
const mongoose = require("mongoose");

const Company    = require("../models/Company");
const PlanConfig = require("../models/PlanConfig");
let Payment;
try { Payment = require("../models/Payment"); } catch { Payment = null; }

const DRY = process.argv.includes("--dry-run");
const log = (...a) => console.log(DRY ? "[dry-run]" : "[migrate]", ...a);

// The custom enterprise PlanConfig we create after freeing the name.
const CUSTOM_ENTERPRISE = {
  planKey:   "enterprise",
  name:      "Enterprise",
  custom:    true,
  description: "Custom plan — contact sales",
  color:     "#0F766E",
  price:     { monthly: 0, yearly: 0 },
  maxAdmins: 10, maxUsers: 999, maxLeads: 999999,
  maxWebsites: 999, maxMetaCampaigns: 999, maxGoogleAccounts: 999, maxStorageMB: 51200,
  transcriptionsPerMonth: 2000, summariesPerMonth: 2000, voiceBotPerMonth: 1000,
  recordingEnabled: true, dataRetentionDays: 365,
  sortOrder: 4,
  isActive:  true,
  features: [
    "leads","contacts","basic-reports","attendance","daily-report",
    "sms-blast","whatsapp-blast","email-blast","campaigns","google-ads",
    "meta-ads","call-recording","projects","tasks","payroll","website-tracking",
  ].map(key => ({ key, label: key, enabled: true })),
};

async function run() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/skyup-crm");
  log("Connected.");

  // ── Step 1: companies enterprise → advance ────────────────────────────────
  const companyCount = await Company.countDocuments({ plan: "enterprise" });
  log(`Companies on "enterprise": ${companyCount}`);
  if (companyCount > 0 && !DRY) {
    const r = await Company.updateMany({ plan: "enterprise" }, { $set: { plan: "advance" } });
    log(`→ Moved ${r.modifiedCount} companies to "advance".`);
  }

  // ── Step 2: rename existing enterprise PlanConfig → advance ───────────────
  // Only if an "advance" row does not already exist (avoid duplicate key).
  const oldEnt   = await PlanConfig.findOne({ planKey: "enterprise", custom: { $ne: true } });
  const hasAdv   = await PlanConfig.findOne({ planKey: "advance" });
  if (oldEnt && !hasAdv) {
    log(`Renaming PlanConfig "enterprise" (${oldEnt.name}) → "advance".`);
    if (!DRY) {
      oldEnt.planKey = "advance";
      if (oldEnt.name === "Enterprise") oldEnt.name = "Advance";
      oldEnt.custom = false;
      await oldEnt.save();
    }
  } else if (hasAdv) {
    log(`"advance" PlanConfig already exists — skipping rename.`);
  } else {
    log(`No legacy "enterprise" PlanConfig to rename.`);
  }

  // ── Step 3: create the custom enterprise PlanConfig ───────────────────────
  const existingCustom = await PlanConfig.findOne({ planKey: "enterprise", custom: true });
  if (!existingCustom) {
    log(`Creating custom "enterprise" PlanConfig (Contact us).`);
    if (!DRY) await PlanConfig.create(CUSTOM_ENTERPRISE);
  } else {
    log(`Custom "enterprise" PlanConfig already exists — skipping.`);
  }

  // ── Step 4: rename past Payment rows for display continuity ───────────────
  if (Payment) {
    const payCount = await Payment.countDocuments({ planId: "enterprise" });
    log(`Payment rows with planId "enterprise": ${payCount}`);
    if (payCount > 0 && !DRY) {
      const r = await Payment.updateMany(
        { planId: "enterprise" },
        { $set: { planId: "advance", planName: "Advance" } }
      );
      log(`→ Updated ${r.modifiedCount} payment rows.`);
    }
  }

  log("Done.");
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error("[migrate] FAILED:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
