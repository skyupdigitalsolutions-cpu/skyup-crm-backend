const mongoose = require("mongoose");

// ── Call history entry (one per agent interaction) ────────────────────────────
const callHistorySchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    userName:  { type: String, default: "" },
    remark:    { type: String, default: "" },
    outcome:   { type: String, default: "" },
    calledAt:  { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Scheduled follow-up / verification call entry ─────────────────────────────
const scheduledCallSchema = new mongoose.Schema(
  {
    type:        { type: String, enum: ["follow-up", "verification"], default: "follow-up" },
    scheduledAt: { type: Date, required: true },
    done:        { type: Boolean, default: false },
    doneAt:      { type: Date, default: null },
    note:        { type: String, default: "" },
  },
  { _id: false }
);

const leadSchema = mongoose.Schema(
  {
    leadgenId: { type: String, unique: true, sparse: true },
    name:      { type: String, required: true, trim: true },
    mobile:    { type: String, required: true },
    email:     { type: String, default: "", trim: true },
    source:    { type: String, required: true, trim: true },
    campaign:  { type: String, required: false, default: null },
    status:    { type: String, required: true, trim: true },
    date:      { type: Date, required: true },
    remark:    { type: String, required: true, trim: true },
    temperature: {
      type: String,
      enum: ["Hot", "Warm", "Cold", null],
      default: null,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      default: null,
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },

    // ── Full history of every agent who handled this lead ────────────────────
    callHistory: {
      type: [callHistorySchema],
      default: [],
    },

    // ── Scheduled follow-up and verification calls ───────────────────────────
    scheduledCalls: {
      type: [scheduledCallSchema],
      default: [],
    },

    // ── Previous agent IDs (used to avoid re-assigning same agent) ───────────
    previousAgents: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
    },

    // ── Reassignment counter ─────────────────────────────────────────────────
    reassignCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const Lead = mongoose.model("Lead", leadSchema);
module.exports = Lead;