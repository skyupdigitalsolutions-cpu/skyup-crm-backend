// scripts/backfillCallRemarks.js
// One-off: clears old "Remark pending" entries in the mobile Calls-by-Day
// screen for calls whose LEAD was already updated by the same agent afterwards.
// Looks back 30 days. Safe to re-run (only touches logs with no real remark).
//   node scripts/backfillCallRemarks.js
require('dotenv').config();
const mongoose = require('mongoose');
const MobileCallLog = require('../models/MobileCallLog');
const Lead = require('../models/Leads');

const AUTO = /^(outgoing|incoming|missed|rejected) call from mobile app/i;

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/skyup-crm');
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const logs = await MobileCallLog.find({
    timestamp: { $gte: since },
    matchedLead: { $ne: null },
    $or: [{ remark: { $exists: false } }, { remark: null }, { remark: '' }, { remark: AUTO }],
  }).select('_id user matchedLead timestamp').lean();

  const leadIds = [...new Set(logs.map((l) => String(l.matchedLead)))];
  const leads = new Map();
  for (let i = 0; i < leadIds.length; i += 500) {
    const rows = await Lead.find({ _id: { $in: leadIds.slice(i, i + 500) } })
      .select('_id status callHistory.userId callHistory.remark callHistory.calledAt').lean();
    rows.forEach((l) => leads.set(String(l._id), l));
  }

  let fixed = 0;
  for (const log of logs) {
    const lead = leads.get(String(log.matchedLead));
    if (!lead) continue;
    const t = new Date(log.timestamp).getTime() - 10 * 60 * 1000; // same call or later
    const hit = (lead.callHistory || [])
      .filter((h) => String(h.userId) === String(log.user) && h.remark && !AUTO.test(h.remark) && new Date(h.calledAt).getTime() >= t)
      .sort((a, b) => new Date(a.calledAt) - new Date(b.calledAt))[0];
    if (!hit) continue;
    await MobileCallLog.updateOne({ _id: log._id }, { $set: { remark: String(hit.remark).slice(0, 500) } });
    fixed++;
  }
  console.log(`✅ Checked ${logs.length} pending calls — marked ${fixed} as done.`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('❌ Backfill failed:', e); process.exit(1); });
