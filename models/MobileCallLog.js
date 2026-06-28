// models/MobileCallLog.js
// Stores call logs synced from the Android app

const mongoose = require('mongoose');

// ── Sub-schema: one recording file per upload ─────────────────────────────────
const recordingSchema = new mongoose.Schema(
  {
    url:        { type: String, required: true },  // e.g. /recordings/userId_ts_file.mp3
    name:       { type: String, default: '' },     // original filename
    size:       { type: Number, default: 0 },      // bytes
    uploadedAt: { type: Date,   default: Date.now },
    // FIX: fileKey for server-side dedup — format: normalizedPhone::filename::mtimeMs
    // Matches the key format used by the mobile app's uploadedSet (uploaded_recordings_v4).
    // If fileKey already exists in recordings[], the upload is rejected as a duplicate.
    fileKey:    { type: String, default: null, index: true },

    // ── AI Transcription & Summary ──────────────────────────────────────────
    transcript:       { type: String, default: null },
    summary:          { type: Object, default: null }, // { summary, keyPoints[], sentiment, nextAction, suggestedTemp }
    // Audio length (seconds) measured from the transcript timestamps, and the
    // whole minutes billed against the company's monthly transcription pool.
    // Stored so usage is auditable and a re-transcribe of the same recording
    // doesn't double-bill (see transcriptionController).
    durationSec:    { type: Number, default: 0 },
    billedMinutes:  { type: Number, default: 0 },
    transcribeStatus: {
      type:    String,
      enum:    ['pending', 'processing', 'done', 'failed'],
      default: 'pending',
    },
  },
  { _id: true },  // each recording gets its own _id so mobile can reference it
);

// ── Main schema ───────────────────────────────────────────────────────────────
const mobileCallLogSchema = new mongoose.Schema(
  {
    user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },

    phoneNumber: { type: String, required: true },
    // Normalised last-10-digit form — used for fast lead matching
    normalizedPhone: { type: String, default: null, trim: true },
    callType: {
      type: String,
      enum: ['incoming', 'outgoing', 'missed', 'voicemail', 'rejected', 'blocked', 'unknown'],
      required: true,
      default: 'outgoing',
    },
    duration:  { type: Number, default: 0 },  // seconds
    timestamp: { type: Date,   required: true },
    name:      { type: String, default: '' },  // contact name from device (if available)

    // Linked CRM lead (auto-matched by phone number on sync)
    matchedLead: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'Lead',
      default: null,
    },

    // ✅ FIX: array of recordings — was a single String before (Bug #2)
    // Each call can now have multiple recordings uploaded independently
    recordings: {
      type:    [recordingSchema],
      default: [],
    },
  },
  { timestamps: true },
);

// ── Indexes ───────────────────────────────────────────────────────────────────
mobileCallLogSchema.index({ user: 1, timestamp: -1 });
// ✅ FIX: compound index now includes callType to match the upsert filter (Bug #3)
mobileCallLogSchema.index({ user: 1, phoneNumber: 1, timestamp: 1, callType: 1 }, { unique: true });
// Fast lead-matching by normalizedPhone
mobileCallLogSchema.index({ company: 1, normalizedPhone: 1 }, { sparse: true });

// Auto-compute normalizedPhone before save
mobileCallLogSchema.pre('validate', function () {
  if (this.phoneNumber) {
    try {
      const { normalizePhone } = require('../utils/normalizePhone');
      this.normalizedPhone = normalizePhone(this.phoneNumber) || null;
    } catch { /* ignore if util not yet available */ }
  }
});

module.exports = mongoose.model('MobileCallLog', mobileCallLogSchema);
