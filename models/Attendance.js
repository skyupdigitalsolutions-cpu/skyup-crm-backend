const mongoose = require("mongoose");

const breakSchema = new mongoose.Schema({
  startTime: { type: Date, required: true },
  endTime:   { type: Date, default: null },
  reason:    { type: String, default: "Manual Break" },
  durationMinutes: { type: Number, default: null },
}, { _id: false });

const attendanceSchema = new mongoose.Schema({
  user:    { type: mongoose.Schema.Types.ObjectId, ref: "User",    required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
  date:    { type: String, required: true }, // "YYYY-MM-DD"

  loginTime:  { type: Date, default: null },
  logoutTime: { type: Date, default: null },

  // Live tracking status (internal)
  status: {
    type: String,
    enum: ["active", "on_break", "idle", "logged_out"],
    default: "active",
  },

  breaks: { type: [breakSchema], default: [] },

  totalWorkMinutes:  { type: Number, default: 0 },
  totalBreakMinutes: { type: Number, default: 0 },

  lastActivity:     { type: Date, default: null },
  activeBreakIndex: { type: Number, default: null },

  // ── CRM Attendance fields (admin-visible / editable) ─────────────────────
  // Manual override for attendance classification.
  // If null, status is auto-derived in the controller (present / late / half_day / absent).
  crmStatus: {
    type: String,
    enum: ["present", "absent", "late", "half_day", "leave", null],
    default: null,
  },

  remarks: { type: String, default: "" },

}, { timestamps: true });

attendanceSchema.index({ user: 1, date: 1 }, { unique: true });
attendanceSchema.index({ company: 1, date: 1 });

module.exports = mongoose.model("Attendance", attendanceSchema);