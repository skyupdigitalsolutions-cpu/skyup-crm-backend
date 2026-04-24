const mongoose = require("mongoose");

const emailLogSchema = new mongoose.Schema(
  {
    to: {
      type: String,
      required: true,
      trim: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
    },
    campaignId: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ["sent", "failed"],
      default: "sent",
    },
    errorMessage: {
      type: String,
      default: null,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
    // Company scope — so each company only sees their own logs
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes for performance ────────────────────────────────────────────────────
emailLogSchema.index({ campaignId: 1 });
emailLogSchema.index({ sentAt: -1 });
emailLogSchema.index({ company: 1, sentAt: -1 });
emailLogSchema.index({ to: 1, company: 1 });

module.exports = mongoose.model("EmailLog", emailLogSchema);