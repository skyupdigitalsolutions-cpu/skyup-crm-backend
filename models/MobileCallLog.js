// ADD THIS FILE TO: skyup-crm-backend/models/MobileCallLog.js
// Stores call logs synced from the Android app

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
    name:      { type: String, default: '' },   // contact name from device (if available)

    // Linked CRM lead (auto-matched by phone number on upload)
    matchedLead: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'Lead',
      default: null,
    },

    // Recording metadata (if user uploads a file)
    recordingUrl:  { type: String, default: null },
    recordingName: { type: String, default: null },
    recordingSize: { type: Number, default: null },
  },
  { timestamps: true },
);

// Index for fast lookup by user + timestamp
mobileCallLogSchema.index({ user: 1, timestamp: -1 });
mobileCallLogSchema.index({ user: 1, phoneNumber: 1 });

module.exports = mongoose.model('MobileCallLog', mobileCallLogSchema);
