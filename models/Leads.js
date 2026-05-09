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

    // ── Normalized phone for deduplication ───────────────────────────────────
    // Always last 10 digits; set automatically by pre-validate hook.
    normalizedPhone: {
      type:    String,
      default: null,
      trim:    true,
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

// ── FIX 4A: Performance indexes ───────────────────────────────────────────────
// Most important: all lead queries filter by company
leadSchema.index({ company: 1 });

// Lead list view: filter by company + user + status
leadSchema.index({ company: 1, user: 1, status: 1 });

// Date-sorted lead list
leadSchema.index({ company: 1, createdAt: -1 });

// Phone number lookup (used in call log sync)
leadSchema.index({ company: 1, mobile: 1 });

// Meta webhook deduplication (leadgenId index already set via unique:true sparse above,
// but explicit compound with company is useful for webhook lookups)
leadSchema.index({ leadgenId: 1 }, { sparse: true });

// ── PHONE DEDUP: Partial unique index on normalizedPhone ─────────────────────
// Partial filter: only enforces uniqueness when normalizedPhone is a non-null string.
// This lets leads with unparseable phones (landlines, test data) coexist safely.
// The compound key {company + normalizedPhone} means the same number can exist
// in different companies (correct behaviour for multi-tenant SaaS).
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
// Fast lookup by normalizedPhone alone (for webhook / API dedup checks)
leadSchema.index({ normalizedPhone: 1 }, { sparse: true });

// ── Pre-validate hook: compute normalizedPhone automatically ─────────────────
leadSchema.pre('validate', function (next) {
  if (this.mobile) {
    const n = normalizePhone(this.mobile);
    this.normalizedPhone = n || null;
  }
  next();
});

// ── Pre-findOneAndUpdate / updateOne / updateMany hooks ───────────────────────
// Keeps normalizedPhone in sync when mobile is updated via update operations.
function syncNormalizedPhoneOnUpdate(next) {
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
  next();
}
leadSchema.pre('findOneAndUpdate', syncNormalizedPhoneOnUpdate);
leadSchema.pre('updateOne',        syncNormalizedPhoneOnUpdate);
leadSchema.pre('updateMany',       syncNormalizedPhoneOnUpdate);

const Lead = mongoose.model("Lead", leadSchema);
module.exports = Lead;