// scripts/backfillLeadRevenue.js — one-time: set each lead's revenueReceived from the total PAID across its active
// invoices, so Marketing ROAS reflects real money for invoices that already exist. Safe to re-run (idempotent).
// Usage:  node scripts/backfillLeadRevenue.js
require("dotenv").config();
const mongoose = require("mongoose");
const FinanceInvoice = require("../models/FinanceInvoice");
const Lead = require("../models/Leads");

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("No MONGO_URI in env"); process.exit(1); }
  await mongoose.connect(uri);
  console.log("Connected. Backfilling lead revenue from paid invoices…");

  // Sum paidAmount per lead across active invoices.
  const rows = await FinanceInvoice.aggregate([
    { $match: { lead: { $ne: null }, status: { $ne: "cancelled" } } },
    { $group: { _id: "$lead", received: { $sum: "$paidAmount" } } },
  ]);
  let updated = 0;
  for (const r of rows) {
    const val = Math.round((r.received || 0) * 100) / 100;
    await Lead.updateOne({ _id: r._id }, { $set: { revenueReceived: val } });
    updated++;
  }
  console.log(`Done. Updated ${updated} lead(s) with revenue from invoices.`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
