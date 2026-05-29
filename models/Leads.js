// models/Leads.js — UPDATED (added assignedAdmin + activityTimeline; all existing fields unchanged)
const mongoose = require("mongoose");
const { normalizePhone } = require("../utils/normalizePhone");

// ── Call history entry (one per agent interaction) ────────────────────────────
const callHistorySchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    userName:  { type: String, default: "" },
    remark:        { type: String, default: "" },
    outcome:       { type: String, default: "" },
    calledAt:      { type: Date, default: Date.now },
    recordingUrl:  { type: String, default: null },
    recordingName: { type: String, default: null },
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
    adSetName: { type: String, default: "", trim: true },
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

    // ── NEW: Admin who owns / manages this lead ───────────────────────────────
    assignedAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    // ── NEW: Full audit trail of every action on this lead ────────────────────
    activityTimeline: [
      {
        action:      { type: String },
        performedBy: { type: mongoose.Schema.Types.ObjectId },
        role:        { type: String },
        timestamp:   { type: Date, default: Date.now },
        note:        { type: String, default: "" },
      },
    ],

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

    // ── Normalized phone for deduplication ───────────────────────────────────
    normalizedPhone: {
      type:    String,
      default: null,
      trim:    true,
    },

    // ── Phone reveal tracking ────────────────────────────────────────────────
    phoneRevealLog: {
      type: [{ 
        userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        userName:   { type: String, default: "" },
        revealedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    phoneRevealCount: { type: Number, default: 0 },

    // ── Additional / alternate phone numbers linked to this lead ─────────────
    additionalNumbers: {
      type: [
        {
          number:    { type: String, required: true, trim: true },
          label:     { type: String, default: "" },   // e.g. "WhatsApp", "Office"
          addedBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          addedAt:   { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    // ── Lead merge tracking ───────────────────────────────────────────────────
    // mergedInto: set on the DUPLICATE lead — points to the surviving lead
    mergedInto: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Lead",
      default: null,
    },
    // mergedFrom: array on the SURVIVING lead — lists all duplicates absorbed
    mergedFrom: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lead" }],
      default: [],
    },

    // ── Close Lead (wrong entry) ──────────────────────────────────────────────
    isClosed: {
      type:    Boolean,
      default: false,
    },
    closeReason: {
      type:    String,
      default: "",
      trim:    true,
    },
    closedAt: {
      type:    Date,
      default: null,
    },
    closedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // ── Projects assigned to this lead ───────────────────────────────────────
    projects: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Project" }],
      default: [],
    },

    // ── Saanvi Voicebot fields ────────────────────────────────────────────────
    voiceBotSummary:    { type: String,  default: "" },
    voiceBotScore:      { type: Number,  default: null },
    voiceBotReason:     { type: String,  default: "" },
    voiceBotNextAction: { type: String,  default: "" },
    voiceBotService:    { type: String,  default: "" },
    voiceBotCallSid:    { type: String,  default: "" },
    voiceBotDuration:   { type: Number,  default: null },
    voiceBotTranscript: { type: String,  default: "" },
    lastCalledByBot:    { type: Date,    default: null },
  },
  { timestamps: true }
);

// ── Performance indexes ───────────────────────────────────────────────────────
leadSchema.index({ company: 1 });
leadSchema.index({ company: 1, user: 1, status: 1 });
leadSchema.index({ company: 1, createdAt: -1 });
leadSchema.index({ company: 1, mobile: 1 });

// ── PHONE DEDUP: Partial unique index on normalizedPhone ─────────────────────
leadSchema.index(
  { company: 1, normalizedPhone: 1 },
  {
    unique: true,
    partialFilterExpression: {
      normalizedPhone: { $type: 'string', $exists: true },
    },
    name: 'company_normalizedPhone_unique',
  }
);
leadSchema.index({ normalizedPhone: 1 }, { sparse: true });

// ── Pre-validate hook: compute normalizedPhone automatically ─────────────────
leadSchema.pre('validate', async function () {
  if (this.mobile) {
    const n = normalizePhone(this.mobile);
    this.normalizedPhone = n || null;
  }
});

// ── Pre-findOneAndUpdate / updateOne / updateMany hooks ───────────────────────
async function syncNormalizedPhoneOnUpdate() {
  try {
    const update = this.getUpdate();
    const mobile =
      (update && update.$set && update.$set.mobile) ||
      (update && update.mobile);
    if (mobile) {
      const n = normalizePhone(mobile);
      if (!update.$set) update.$set = {};
      update.$set.normalizedPhone = n || null;
      this.setUpdate(update);
    }
  } catch (err) {
    console.error("syncNormalizedPhoneOnUpdate error:", err);
  }
}
leadSchema.pre('findOneAndUpdate', syncNormalizedPhoneOnUpdate);
leadSchema.pre('updateOne',        syncNormalizedPhoneOnUpdate);
leadSchema.pre('updateMany',       syncNormalizedPhoneOnUpdate);

const Lead = mongoose.model("Lead", leadSchema);
module.exports = Lead;
