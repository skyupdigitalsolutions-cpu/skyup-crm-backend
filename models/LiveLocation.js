// models/LiveLocation.js
// ─────────────────────────────────────────────────────────────────────────────
// Stores periodic GPS pings from employees who have client-meeting permission
// active. Pings are sent every N minutes as configured by the admin
// (Company.meetingLocationIntervalMinutes, default 15).
//
// Each document is one ping. The admin/super_admin can view the trail of pings
// for each employee on the Attendance page to track client visits.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const liveLocationSchema = new mongoose.Schema({
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },

  // GPS coordinates captured from device
  latitude:  { type: Number, required: true },
  longitude: { type: Number, required: true },
  accuracy:  { type: Number, default: null },   // metres, from Geolocation API

  // Date of the attendance session this ping belongs to ("YYYY-MM-DD")
  date: { type: String, required: true },

  // Optional: address string resolved by client-side reverse geocoding
  address: { type: String, default: null, trim: true },

  // Context tag: 'meeting' | 'active'
  context: { type: String, default: 'meeting', enum: ['meeting', 'active'] },

  capturedAt: { type: Date, default: Date.now },
}, { timestamps: false });

// Index for fast per-user per-day queries
liveLocationSchema.index({ company: 1, date: 1 });
liveLocationSchema.index({ user: 1, date: 1, capturedAt: -1 });

// Auto-delete after 30 days (keeps DB tidy; admin can export if needed)
liveLocationSchema.index({ capturedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('LiveLocation', liveLocationSchema);
