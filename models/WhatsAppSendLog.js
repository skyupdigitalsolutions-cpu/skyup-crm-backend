// models/WhatsAppSendLog.js
// ─────────────────────────────────────────────────────────────────────────────
// One row per WhatsApp template send attempt, across every send path:
//   channel "blast"          → admin "Campaign leads" / "Single lead" bulk send
//   channel "blast-csv"      → admin CSV import bulk send
//   channel "employee-blast" → employee's own-leads bulk send
//   channel "nurture"        → automated nurture sequence (cron or immediate trigger)
//
// Previously each send path returned its results ONLY in the HTTP response —
// nothing was persisted, so there was no way to answer "what did we send
// today" or "did the nurture job actually message this lead" after the fact.
// This collection is the single source of truth for that report.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const whatsAppSendLogSchema = new mongoose.Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      default: null,
      index: true,
    },
    phone: { type: String, default: "" },
    name:  { type: String, default: "" },

    templateName: { type: String, default: "" },
    languageCode: { type: String, default: "" },

    channel: {
      type: String,
      enum: ["blast", "blast-csv", "employee-blast", "nurture", "manual"],
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["sent", "failed", "skipped"],
      required: true,
      index: true,
    },
    reason: { type: String, default: "" }, // failure/skip detail

    // Who initiated the send. For "blast"/"blast-csv" this is the admin;
    // for "employee-blast" the employee; for "nurture" it's system-fired so
    // sentByName is just "Nurture automation" and the user refs stay null.
    sentByAdmin: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    sentByUser:  { type: mongoose.Schema.Types.ObjectId, ref: "User",  default: null },
    sentByName:  { type: String, default: "" },

    // Only set for channel "nurture"
    ruleId:   { type: mongoose.Schema.Types.ObjectId, ref: "NurtureRule", default: null },
    ruleName: { type: String, default: "" },

    // Extra context — which campaign/blast batch this was part of, if any.
    campaign: { type: String, default: "" },

    waMessageId: { type: String, default: "" },
  },
  { timestamps: true }
);

whatsAppSendLogSchema.index({ company: 1, createdAt: -1 });
whatsAppSendLogSchema.index({ company: 1, channel: 1, createdAt: -1 });
whatsAppSendLogSchema.index({ company: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("WhatsAppSendLog", whatsAppSendLogSchema);
