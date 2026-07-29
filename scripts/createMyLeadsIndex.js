// scripts/createMyLeadsIndex.js
// One-off: builds the { company, user, mergedInto, createdAt } index added to
// models/Leads.js for the GET /lead/my-leads query. Existing collections
// don't pick up new schema indexes automatically in production (autoIndex is
// off), so run this once after deploying the model change:
//   node scripts/createMyLeadsIndex.js
require('dotenv').config();
const mongoose = require('mongoose');
const Lead = require('../models/Leads');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/skyup-crm');
  console.log('Building index on leads: { company:1, user:1, mergedInto:1, createdAt:-1 } ...');
  const name = await Lead.collection.createIndex(
    { company: 1, user: 1, mergedInto: 1, createdAt: -1 },
  );
  console.log('✅ Index built:', name);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('❌ Index build failed:', e);
  process.exit(1);
});