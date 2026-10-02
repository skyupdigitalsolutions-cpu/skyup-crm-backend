// scripts/createPerfIndexes.js
// One-off, SAFE (only creates missing indexes, never drops any).
// Builds every index declared in the main models so list pages, dashboards
// and call logs use indexes instead of scanning whole collections.
//   node scripts/createPerfIndexes.js
require('dotenv').config();
const mongoose = require('mongoose');

const MODELS = [
  'Leads', 'Users', 'Admin', 'Company', 'MobileCallLog', 'Attendance', 'Contact', 'Project', 'Call',
  'WhatsAppConversation', 'WhatsAppMessage', 'Message', 'ChatUser', 'Payment',
  'GoogleAdsConfig', 'WebsiteConfig', 'MetaConfig', 'CustomReport',
];

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/skyup-crm');
  for (const name of MODELS) {
    let Model;
    try { Model = require(`../models/${name}`); } catch (_) { continue; }
    const t = Date.now();
    try {
      await Model.createIndexes();
      console.log(`✅ ${Model.modelName.padEnd(16)} indexes ready (${Date.now() - t} ms)`);
    } catch (e) {
      console.warn(`⚠️  ${Model.modelName}: ${e.message}`);
    }
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('❌ Index build failed:', e);
  process.exit(1);
});
