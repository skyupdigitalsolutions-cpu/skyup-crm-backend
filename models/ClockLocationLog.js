// models/ClockLocationLog.js
// ─────────────────────────────────────────────────────────────────────────────
// PERMANENT clock-in / clock-out location log.
//
// Every clock-in and clock-out writes ONE immutable document here. Unlike the
// daily Attendance record (which an admin can edit or delete) and unlike
// LiveLocation (which auto-expires after 30 days), this collection is:
//   • append-only  — we only ever create; never update or delete
//   • has NO TTL   — data is kept permanently
//
// This is the durable source of truth / audit trail for where employees clocked
// in and out, so the location survives even if the attendance record is removed.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const clockLocationLogSchema = new mongoose.Schema(
  {
    user:    { type: mongoose.Schema.Types.ObjectId, ref: "User",    required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },

    // 'clock_in' | 'clock_out' | 'clock_in_rejected'
    // FIX (missing audit trail): an out-of-geofence clock-in attempt was
    // rejected with a 403 and the location the employee tried from was
    // simply discarded — no record of it anywhere. That's actual, useful
    // data (who tried to clock in from where, and got blocked) that admins
    // reasonably want visibility into, distinct from a real clock-in.
    type: { type: String, enum: ["clock_in", "clock_out", "clock_in_rejected"], required: true },

    // Attendance day this event belongs to ("YYYY-MM-DD")
    date: { type: String, required: true },

    // GPS captured from the device
    latitude:  { type: Number, required: true },
    longitude: { type: Number, required: true },
    accuracy:  { type: Number, default: null }, // metres

    // Optional reverse-geocoded address (if the client sends one)
    address: { type: String, default: null, trim: true },

    // Only set for type: "clock_in_rejected" — how far outside the allowed
    // radius this attempt was, so admins reviewing the log don't have to
    // recompute it themselves.
    distanceMetres: { type: Number, default: null },
    radiusMetres:   { type: Number, default: null },

    capturedAt: { type: Date, default: Date.now },
  },
  { timestamps: true } // createdAt/updatedAt; NO TTL index — kept permanently
);

// Fast history queries. Deliberately NO expireAfterSeconds index anywhere.
clockLocationLogSchema.index({ company: 1, date: 1 });
clockLocationLogSchema.index({ company: 1, user: 1, capturedAt: -1 });

module.exports = mongoose.model("ClockLocationLog", clockLocationLogSchema);
