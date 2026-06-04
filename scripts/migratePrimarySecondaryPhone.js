// scripts/migratePrimarySecondaryPhone.js
// One-time migration: copies `mobile` → `primaryPhone` for all existing leads.
// Run ONCE after deploying the new Lead model.
// Usage: node scripts/migratePrimarySecondaryPhone.js
require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const { normalizePhone } = require("../utils/normalizePhone");
  const Lead = require("../models/Leads");

  // Find all leads where primaryPhone is not yet set
  const leads = await Lead.find({ primaryPhone: { $in: [null, undefined, ""] } }).lean();
  console.log(`Found ${leads.length} leads to migrate`);

  let ok = 0, err = 0;
  for (const lead of leads) {
    try {
      const primary = lead.mobile || "";
      const norm    = normalizePhone(primary);
      await Lead.updateOne(
        { _id: lead._id },
        {
          $set: {
            primaryPhone:              primary,
            mobile:                    primary,
            normalizedPhone:           norm || null,
            // secondaryPhone starts as null — can be added later
            secondaryPhone:            null,
            normalizedSecondaryPhone:  null,
          },
        }
      );
      ok++;
    } catch (e) {
      console.error(`Lead ${lead._id}: ${e.message}`);
      err++;
    }
  }
  console.log(`Migration complete: ${ok} updated, ${err} errors`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
