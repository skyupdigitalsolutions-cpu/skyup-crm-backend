// models/FestivalCampaign.js
//
// A company admin schedules a WhatsApp (+ optional Email) "festival
// greeting" template to go out to their leads on a specific calendar date —
// e.g. "send skyup_happy_diwali to every lead on 8 Nov 2026". One document =
// one scheduled blast for one company on one date.
//
// jobs/festivalCampaignJob.js polls for documents whose `sendDateKey` matches
// today (IST) and are still `status: "scheduled"`, atomically claims them
// (scheduled → sending) so a restart or overlapping tick can never double-fire,
// then sends to every matching lead of that company and records stats here.
//
// Deliberately its own collection (not embedded on Company, unlike
// autoTemplate/interestedBlast) because a company can have many of these
// over time, each with its own one-off date and its own send history/stats —
// an array-of-subdocs on Company would make querying "what's due today
// across all companies" and updating stats mid-send much messier.

"use strict";

const mongoose = require("mongoose");
const { istDayKey } = require("../utils/istDate");

const whatsappChannelSchema = new mongoose.Schema(
  {
    enabled:      { type: Boolean, default: true },
    templateName: { type: String,  default: "" },
    languageCode: { type: String,  default: "en" },
  },
  { _id: false }
);

const emailChannelSchema = new mongoose.Schema(
  {
    enabled:      { type: Boolean, default: false },
    subject:      { type: String,  default: "" },
    fromName:     { type: String,  default: "" },
    bodyTemplate: { type: String,  default: "" },
  },
  { _id: false }
);

const festivalCampaignSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    // Optional link back to utils/festivalTemplateCatalog.js — lets the UI
    // show "picked from catalog" vs a fully custom one-off campaign. Not
    // required: an admin can also type a fully custom template/date.
    festivalKey:  { type: String, default: "" },
    festivalName: { type: String, required: true, trim: true },

    // The calendar date this should fire on. Stored as a real Date for
    // display/sorting, PLUS a precomputed IST "YYYY-M-D" key (below) that the
    // job matches against — avoids any UTC/IST off-by-one at day boundaries.
    sendDate:    { type: Date, required: true },
    sendDateKey: { type: String, index: true },

    // Who gets it. `all` = every lead in the company. `byStatus` = only
    // leads whose current status is in `statuses` (e.g. only "Interested" or
    // "New" — skips "Junk"/"Lost" etc.).
    targetAudience: {
      scope:    { type: String, enum: ["all", "byStatus"], default: "all" },
      statuses: { type: [String], default: [] },
    },

    channels: {
      whatsapp: { type: whatsappChannelSchema, default: () => ({}) },
      email:    { type: emailChannelSchema,    default: () => ({}) },
    },

    // Admin can pause a scheduled campaign without deleting it.
    enabled: { type: Boolean, default: true },

    status: {
      type: String,
      enum: ["scheduled", "sending", "sent", "failed", "cancelled"],
      default: "scheduled",
      index: true,
    },

    stats: {
      totalLeads: { type: Number, default: 0 },
      sent:       { type: Number, default: 0 },
      failed:     { type: Number, default: 0 },
      skipped:    { type: Number, default: 0 },
    },

    startedAt: { type: Date, default: null },
    sentAt:    { type: Date, default: null },
    lastError: { type: String, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

// Keep sendDateKey in lockstep with sendDate whenever either is set/changed.
festivalCampaignSchema.pre("save", function (next) {
  if (this.isModified("sendDate") && this.sendDate) {
    this.sendDateKey = istDayKey(this.sendDate);
  }
  next();
});

// Compound index used by the daily job: "campaigns due today, still pending".
festivalCampaignSchema.index({ sendDateKey: 1, status: 1, enabled: 1 });

module.exports = mongoose.model("FestivalCampaign", festivalCampaignSchema);
