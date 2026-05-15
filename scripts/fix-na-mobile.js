/**
 * fix-na-mobile.js
 *
 * One-time migration: re-fetches phone numbers from Meta Graph API
 * for all leads saved with mobile = "N/A" or mobile = "".
 *
 * Run with:
 *   node scripts/fix-na-mobile.js
 *
 * Requires MONGO_URI and at least one MetaConfig with a valid pageAccessToken.
 */

require("dotenv").config();
const mongoose  = require("mongoose");
const axios     = require("axios");
const Lead      = require("../models/Leads");
const MetaConfig = require("../models/MetaConfig");
const { parseFieldData, mapToLeadSchema } = require("../utils/metaHelper");
const { normalizePhone } = require("../utils/normalizePhone");

async function refetchPhone(lead, configs) {
  if (!lead.leadgenId) return null;

  // Find a MetaConfig for this lead's campaign
  const cfg = configs.find(c => c.campaignName === lead.campaign) || configs[0];
  if (!cfg || !cfg.pageAccessToken) return null;

  const version = cfg.graphApiVersion || process.env.META_GRAPH_API_VERSION || "v19.0";
  try {
    const { data } = await axios.get(
      `https://graph.facebook.com/${version}/${lead.leadgenId}`,
      { params: { fields: "field_data", access_token: cfg.pageAccessToken } }
    );
    const parsed = parseFieldData(data.field_data || []);
    console.log(`   field_data keys: ${Object.keys(parsed).join(", ")}`);

    // Re-use the same smart extraction logic
    const { extractPhone } = require("../utils/metaHelper");
    // extractPhone is not exported — inline it here
    const PHONE_KEYS = [
      "phone_number","phone","mobile","mobile_number","contact_number",
      "contact","cell","cell_number","whatsapp","whatsapp_number","tel",
      "telephone","number","mob","ph",
    ];
    let raw = "";
    for (const k of PHONE_KEYS) {
      if (parsed[k]) { raw = String(parsed[k]).trim(); break; }
    }
    if (!raw) {
      for (const [k, v] of Object.entries(parsed)) {
        if (!v) continue;
        const s = String(v).trim();
        const digits = s.replace(/\D/g,"");
        if (digits.length >= 5 && digits.length <= 15 && !s.includes("@") && !/^[a-zA-Z\s]+$/.test(s)) {
          raw = s; break;
        }
      }
    }
    const norm   = normalizePhone(raw);
    const mobile = norm || raw.replace(/\D/g,"") || "";
    return mobile || null;
  } catch (err) {
    console.warn(`   ⚠️  Meta API error for ${lead.leadgenId}: ${err?.response?.data?.error?.message || err.message}`);
    return null;
  }
}

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error("❌ No MONGO_URI in environment"); process.exit(1); }

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB\n");

  const configs = await MetaConfig.find({ isActive: true }).lean();
  console.log(`Found ${configs.length} active MetaConfig(s)\n`);

  // Find all broken leads
  const broken = await Lead.find({
    $or: [{ mobile: "N/A" }, { mobile: "" }, { mobile: null }],
    source: "Meta",
  }).select("_id name mobile leadgenId campaign").lean();

  console.log(`Found ${broken.length} Meta lead(s) with missing/N/A phone\n`);

  let fixed = 0, failed = 0;

  for (const lead of broken) {
    console.log(`• [${lead._id}] ${lead.name} | leadgenId: ${lead.leadgenId}`);
    const phone = await refetchPhone(lead, configs);
    if (phone) {
      const norm = normalizePhone(phone);
      await Lead.findByIdAndUpdate(lead._id, {
        $set: { mobile: phone, normalizedPhone: norm || null },
      });
      console.log(`  ✅ Fixed → "${phone}"\n`);
      fixed++;
    } else {
      console.log(`  ❌ Could not recover phone\n`);
      failed++;
    }
    // Rate-limit: avoid hammering Meta API
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. Fixed: ${fixed}  |  Failed: ${failed}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
