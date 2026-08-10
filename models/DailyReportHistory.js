// models/DailyReportHistory.js
// ─────────────────────────────────────────────────────────────────────────────
// Stores one record per report execution attempt per company per day.
// Used by the admin UI to show whether the report was sent successfully.
// NEVER stores Telegram bot tokens.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require('mongoose');

const dailyReportHistorySchema = new mongoose.Schema(
  {
    company:    { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    reportDate: { type: String, required: true }, // "YYYY-MM-DD" in company timezone
    generatedAt:   { type: Date, default: Date.now },
    scheduledTime: { type: String }, // "HH:MM" — the configured report time
    timezone:      { type: String },

    employeeCount: { type: Number, default: 0 },
    status: {
      type:    String,
      enum:    ['pending', 'sent', 'failed', 'skipped'],
      default: 'pending',
    },
    // Telegram message IDs returned by the Bot API (for reference only)
    telegramMessageIds: { type: [Number], default: [] },
    errorMessage: { type: String, default: null },

    // Whether the report was triggered manually (Send Now) vs scheduled
    triggeredBy: {
      type:    String,
      enum:    ['scheduler', 'manual', 'test'],
      default: 'scheduler',
    },
  },
  { timestamps: true },
);

// ── Compound index: one record per company per day per trigger type ───────────
// Prevents duplicate scheduled sends for the same company+date.
dailyReportHistorySchema.index(
  { company: 1, reportDate: 1, triggeredBy: 1 },
  { unique: true },
);

// ── TTL: auto-delete history older than 90 days ───────────────────────────────
dailyReportHistorySchema.index(
  { generatedAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);

module.exports = mongoose.model('DailyReportHistory', dailyReportHistorySchema);
