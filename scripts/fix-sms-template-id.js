/**
 * scripts/fix-sms-template-id.js
 *
 * One-time fix: updates any SmsConfig record that still has the DLT ID
 * (1007503933418344595) stored as greetingsTemplateId, replacing it with
 * the correct MSG91 Flow ID (6a1ffe028c6272147b00b233).
 *
 * Run ONCE on your server:
 *   node scripts/fix-sms-template-id.js
 */

"use strict";

require("dotenv").config();
const mongoose  = require("mongoose");
const SmsConfig = require("../models/SmsConfig");

const WRONG_ID   = "1007503933418344595";   // DLT ID — must NOT be sent to MSG91 API
const CORRECT_ID = "6a1ffe028c6272147b00b233"; // MSG91 Flow ID — this is what /api/v5/flow/ needs

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    // Find all records with the wrong ID
    const bad = await SmsConfig.find({ greetingsTemplateId: WRONG_ID });
    console.log(`Found ${bad.length} SmsConfig record(s) with the wrong DLT ID`);

    if (bad.length === 0) {
      console.log("Nothing to fix — all records already have the correct MSG91 Flow ID.");
      process.exit(0);
    }

    const result = await SmsConfig.updateMany(
      { greetingsTemplateId: WRONG_ID },
      { $set: { greetingsTemplateId: CORRECT_ID } }
    );

    console.log(`✅ Fixed ${result.modifiedCount} record(s): greetingsTemplateId → ${CORRECT_ID}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
})();