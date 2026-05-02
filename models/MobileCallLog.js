// models/MobileCallLog.js
const mongoose = require('mongoose');

const mobileCallLogSchema = new mongoose.Schema(
  {
    user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },

    phoneNumber: { type: String, required: true },
    callType:    {
      type: String,
      enum: ['incoming', 'outgoing', 'missed', 'voicemail', 'rejected', 'blocked', 'unknown'],
      required: true,
    },
    duration:  { type: Number, default: 0 },   // seconds
    timestamp: { type: Date,   required: true },
    name:      { type: String, default: '' },   // contact name from device

    // Linked CRM lead (auto-matched by phone number on upload)
    matchedLead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', default: null },

    // Agent remark + outcome added after call (from mobile app)
    remark:  { type: String, default: '' },
    outcome: { type: String, default: '' },

    // Recording metadata (uploaded from mobile app)
    recordingUrl:  { type: String, default: null },
    recordingName: { type: String, default: null },
    recordingSize: { type: Number, default: null },
  },
  { timestamps: true },
);

mobileCallLogSchema.index({ user: 1, timestamp: -1 });
mobileCallLogSchema.index({ user: 1, phoneNumber: 1 });
mobileCallLogSchema.index({ company: 1, recordingUrl: 1 });
mobileCallLogSchema.index({ matchedLead: 1 });

module.exports = mongoose.model('MobileCallLog', mobileCallLogSchema);
