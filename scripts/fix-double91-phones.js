/**
 * scripts/fix-double91-phones.js
 *
 * One-time fix for leads whose mobile numbers got a double "91" prefix
 * from a bad bulk Atlas update.
 *
 * Before: "+918496868060"  (correct)
 * After bad update: "+91918496868060"  (wrong — 14 digits)
 *
 * This script finds all such leads and corrects both `mobile` and
 * `normalizedPhone` fields.
 *
 * USAGE:
 *   node scripts/fix-double91-phones.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('❌  MONGO_URI not set'); process.exit(1); }

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  // Fix double-91
  if (digits.startsWith('9191') && digits.length === 14) digits = digits.slice(2);
  // Strip known prefixes
  const prefixes = ['0091', '091', '001', '01', '0044', '044'];
  for (const p of prefixes) {
    if (digits.startsWith(p) && digits.length > p.length) { digits = digits.slice(p.length); break; }
  }
  if (digits.startsWith('0') && digits.length > 10) digits = digits.slice(1);
  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length !== 10) return null;
  if (/^(\d)\1{9}$/.test(digits)) return null;
  return digits;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected to MongoDB\n');

  const db = mongoose.connection.db;
  const leads = db.collection('leads');
  const convs = db.collection('whatsappconversations');

  // ── STEP 1: Find leads with double-91 mobile numbers ─────────────────────
  // Pattern: mobile contains "9191" which is 14+ digits
  const badLeads = await leads.find({
    mobile: { $regex: /9191\d{10}/ }
  }).project({ _id: 1, mobile: 1, company: 1, name: 1 }).toArray();

  console.log(`🔍  Found ${badLeads.length} lead(s) with double-91 mobile numbers\n`);

  let leadsFixed = 0, convsFixed = 0, errors = 0;

  for (const lead of badLeads) {
    const oldMobile = lead.mobile;
    // Strip the non-digit chars, fix double-91
    const digitsOnly = String(oldMobile).replace(/\D/g, '');
    let fixed = digitsOnly;
    if (fixed.startsWith('9191') && fixed.length === 14) fixed = fixed.slice(2);
    // Restore the + prefix style if original had it
    const newMobile = oldMobile.startsWith('+') ? '+' + fixed : fixed;
    const newNormalized = normalizePhone(newMobile);

    console.log(`  Lead: ${lead.name}`);
    console.log(`    mobile:          "${oldMobile}"  →  "${newMobile}"`);
    console.log(`    normalizedPhone: →  "${newNormalized}"`);

    try {
      await leads.updateOne(
        { _id: lead._id },
        { $set: { mobile: newMobile, normalizedPhone: newNormalized } }
      );
      leadsFixed++;

      // ── STEP 2: Fix the corresponding WhatsAppConversation.waPhone ────────
      // The conversation may have been created with the bad phone too
      const badWaPhone = digitsOnly; // "91918496868060" (14 digits, no +)
      const goodWaPhone = fixed;     // "918496868060" (12 digits)

      const convResult = await convs.updateMany(
        { waPhone: badWaPhone, company: lead.company },
        { $set: { waPhone: goodWaPhone } }
      );
      if (convResult.modifiedCount > 0) {
        console.log(`    ✅  Fixed ${convResult.modifiedCount} conversation(s) waPhone`);
        convsFixed += convResult.modifiedCount;
      }
    } catch (err) {
      console.error(`    ❌  Error: ${err.message}`);
      errors++;
    }
    console.log('');
  }

  // ── STEP 3: Also check leads with mobile like "91918XXXXXXXXX" without + ──
  const badLeads2 = await leads.find({
    mobile: { $regex: /^91918\d{9}$/ }
  }).project({ _id: 1, mobile: 1, company: 1, name: 1 }).toArray();

  const newOnes = badLeads2.filter(l => !badLeads.some(b => b._id.toString() === l._id.toString()));
  if (newOnes.length > 0) {
    console.log(`🔍  Found ${newOnes.length} more lead(s) with bare double-91 (no +)\n`);
    for (const lead of newOnes) {
      const fixed = lead.mobile.slice(2); // strip leading "91"
      const newNormalized = normalizePhone(fixed);
      console.log(`  Lead: ${lead.name}  "${lead.mobile}" → "${fixed}"`);
      try {
        await leads.updateOne(
          { _id: lead._id },
          { $set: { mobile: fixed, normalizedPhone: newNormalized } }
        );
        leadsFixed++;
        await convs.updateMany(
          { waPhone: lead.mobile, company: lead.company },
          { $set: { waPhone: fixed } }
        );
      } catch (err) {
        console.error(`  ❌  Error: ${err.message}`);
        errors++;
      }
    }
  }

  console.log('─────────────────────────────────────────────────');
  if (leadsFixed === 0 && errors === 0) {
    console.log('✅  No double-91 numbers found. Your data is clean!');
    console.log('\n💡  If messaging is still broken, the issue is NOT the phone number format.');
    console.log('    Check your MSG91 template approval status in MSG91 dashboard.');
    console.log('    Also check your server logs for the MSG91 API response when sending.');
  } else {
    console.log(`📊  Fixed: ${leadsFixed} lead(s), ${convsFixed} conversation(s) | Errors: ${errors}`);
  }
  console.log('─────────────────────────────────────────────────');

  await mongoose.disconnect();
}

main().catch(err => { console.error('❌  Fatal:', err); process.exit(1); });