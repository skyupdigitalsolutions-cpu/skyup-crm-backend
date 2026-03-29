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
}, { timestamps: true });

module.exports = mongoose.model('Call', callSchema);