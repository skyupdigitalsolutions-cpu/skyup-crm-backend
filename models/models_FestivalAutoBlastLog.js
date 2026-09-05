// models/FestivalAutoBlastLog.js
//
// One row = "festival X was (or is being) sent to company Y's leads in year
// Z". The unique index on (company, festivalKey, year) IS the atomic claim
// mechanism for jobs/festivalCampaignJob.js's catalog-driven auto-blast:
// creating this row is the claim — if a duplicate insert is attempted (a
// second cron tick, or a second server instance), Mongo rejects it with
// E11000 and the job simply skips, so a festival can never fire twice for
// the same company in the same year.
//
// `year` is stored explicitly (not derived from `createdAt`) so re-running
// the SAME catalog entry next year — same festivalKey, new date — is treated
// as a brand new send, not blocked by last year's log row.

"use strict";

const mongoose = require("mongoose");

const festivalAutoBlastLogSchema = new mongoose.Schema(
  {
    company:      { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    festivalKey:  { type: String, required: true },
    festivalName: { type: String, default: "" },
    year:         { type: Number, required: true },

    status: {
      type: String,
      enum: ["sending", "sent", "failed"],
      default: "sending",
    },

    stats: {
      totalLeads: { type: Number, default: 0 },
      sent:       { type: Number, default: 0 },
      failed:     { type: Number, default: 0 },
      skipped:    { type: Number, default: 0 },
    },

    startedAt: { type: Date, default: Date.now },
    sentAt:    { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

festivalAutoBlastLogSchema.index({ company: 1, festivalKey: 1, year: 1 }, { unique: true });

module.exports = mongoose.model("FestivalAutoBlastLog", festivalAutoBlastLogSchema);
