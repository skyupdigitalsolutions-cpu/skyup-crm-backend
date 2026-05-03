// models/Call.js
const mongoose = require('mongoose');

const callSchema = new mongoose.Schema({
  callSid:           { type: String, required: true, unique: true },
  contactId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  contactName:       { type: String },
  agentIdentity:     { type: String },
  status:            { type: String, default: 'initiated' },
  recordingSid:      { type: String },
  recordingUrl:      { type: String },
  recordingDuration: { type: String },
  recordedAt:        { type: Date },

  // ── AI Transcription & Summary ────────────────────────────────────────────
  transcript:       { type: String,  default: null },
  summary:          { type: Object,  default: null }, // { summary, keyPoints[], sentiment, nextAction, suggestedTemp }
  transcribeStatus: {
    type:    String,
    enum:    ['pending', 'processing', 'done', 'failed'],
    default: 'pending',
  },
}, { timestamps: true });

module.exports = mongoose.model('Call', callSchema);