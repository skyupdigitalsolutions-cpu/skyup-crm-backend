// models/Leads.js — MERGED (all fields from both versions)
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
    calledNumber:  { type: String, default: null },
    numberType:    { type: String, default: null },   // "Primary" | "Secondary"
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

// ── Client meeting remark entry (one per field visit / video call / demo) ─────
const meetingRemarkSchema = new mongoose.Schema(
  {
    userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName:     { type: String, default: '' },
    meetingType:  {
      type:    String,
      enum:    ['In-Person', 'Video Call', 'Phone Call', 'Site Visit', 'Demo'],
      default: 'In-Person',
    },
    outcome:      { type: String, default: '' },
    remark:       { type: String, default: '' },
    metAt:        { type: Date, default: Date.now },
    followUpDate: { type: Date, default: null },
    documentUrl:  { type: String, default: null },
    documentName: { type: String, default: null },
    recordingUrl: { type: String, default: null },
    recordingName:{ type: String, default: null },
    // Tracks which of the 3 meeting reminders (WhatsApp + email) have already
    // been sent for this meeting, so the cron never double-sends:
    //   scheduledAt  — fired immediately when the meeting was scheduled
    //   dayBeforeAt  — fired the morning of the day BEFORE the meeting
    //   meetingDayAt — fired the morning OF the meeting day
    reminders: {
      scheduledAt:  { type: Date, default: null },
      dayBeforeAt:  { type: Date, default: null },
      meetingDayAt: { type: Date, default: null },
    },
  },
  { _id: true },
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
    // Reference to the exact MetaConfig (ad set) this lead came from. Lets the
    // Campaigns page count leads per AD SET instead of per campaign name (which
    // collides when several ad sets share a campaign name).
    metaConfigId: { type: mongoose.Schema.Types.ObjectId, ref: "MetaConfig", default: null, index: true },
    // The exact Meta lead FORM id this lead was submitted through. In Meta, each
    // lead form belongs to one ad set, so formId is the ground-truth key for
    // attributing a lead to its ad set — independent of the campaign name. Stored
    // so leads can be re-attributed to the correct ad-set config if they were
    // routed to a catch-all config at ingestion time.
    formId: { type: String, default: "", trim: true, index: true },
    status:    { type: String, required: true, trim: true },
    date:      { type: Date, required: true },
    remark:    { type: String, required: true, trim: true },
    temperature: {
      type: String,
      enum: ["Hot", "Warm", "Cold", null],
      default: null,
    },

    // ── Qualification scoring (Meta Ad Set leads) ─────────────────────────────
    leadScore: {
      type:    Number,
      default: null,
    },
    // Maximum possible score for the rule-set that scored this lead
    // (= number of qualification questions × 100).
    maxScore: {
      type:    Number,
      default: null,
    },
    // (leadScore / maxScore) × 100, rounded to 2 decimals.
    qualificationPercentage: {
      type:    Number,
      default: null,
    },
    leadCategory: {
      type:    String,
      enum:    ["Hot", "Warm", "Cold", null],
      default: null,
    },
    qualificationBreakdown: {
      type:    Array,
      default: [],
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

    // ── Admin who owns / manages this lead ───────────────────────────────────
    assignedAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    // ── Full audit trail of every action on this lead ─────────────────────────
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

    // ── Client meeting remarks (field visits, demos, video calls) ─────────────
    // Logged from the mobile app's "Client Meeting" screen.
    // Each entry can carry a document and/or recording attachment.
    meetingRemarks: {
      type: [meetingRemarkSchema],
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
    reassignCount:     { type: Number, default: 0 },

    // ── Not-Interested verification flow ─────────────────────────────────────
    // When an employee marks a lead Not Interested, it is reassigned to another
    // agent for verification. niOriginalAgent remembers the employee who first
    // raised it, so that if the verifier ALSO marks it Not Interested the lead
    // is sent back to that original employee.
    niOriginalAgent: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },
    // Stage of the NI flow: null (none) → "verification" (with a verifier)
    // → "returned" (verifier disagreed, sent back to original employee).
    niStage: {
      type:    String,
      enum:    [null, "verification", "returned"],
      default: null,
    },

    // ── Invalid verification flow ────────────────────────────────────────────
    // When an employee marks a lead Invalid, it is reassigned to another agent
    // for verification. invalidOriginalAgent remembers the employee who first
    // raised it. If the verifier ALSO marks it Invalid, the lead is CLOSED
    // (isClosed=true) and removed from every employee panel — it then lives only
    // in the admin "Closed Leads" view. If the verifier DISAGREES, the lead is
    // returned to the original employee and the admin is notified.
    invalidOriginalAgent: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },
    // Stage of the Invalid flow: null (none) → "verification" (with a verifier).
    invalidStage: {
      type:    String,
      enum:    [null, "verification"],
      default: null,
    },
    // Reassignment counter for the Invalid flow.
    invalidReassignCount: { type: Number, default: 0 },

    // ── Cold reassignment counter (separate from NI reassign) ────────────────
    coldReassignCount: { type: Number, default: 0 },

    // ── Cold-lead verification flow (mirrors the Not-Interested flow) ────────
    // When an employee marks a lead Cold, it is reassigned to another agent for
    // verification. coldOriginalAgent remembers the employee who first marked it
    // Cold, so that if the verifier ALSO marks it Cold it returns to that agent.
    coldOriginalAgent: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "User",
      default: null,
    },
    // Stage of the Cold flow: null → "verification" → "returned".
    coldStage: {
      type:    String,
      enum:    [null, "verification", "returned"],
      default: null,
    },

    // ── Primary phone (explicit field; mirrors mobile for backward compat) ────
    primaryPhone: {
      type:    String,
      default: null,
      trim:    true,
    },

    // ── Secondary / alternate phone number ────────────────────────────────────
    secondaryPhone: {
      type:    String,
      default: null,
      trim:    true,
    },

    // ── Normalized phone for deduplication ───────────────────────────────────
    normalizedPhone: {
      type:    String,
      default: null,
      trim:    true,
    },

    // ── Normalized secondary phone for deduplication ──────────────────────────
    normalizedSecondaryPhone: {
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

    // ── Email reveal tracking (mirrors phone reveal) ───────────────────────────
    emailRevealLog: {
      type: [{
        userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        userName:   { type: String, default: "" },
        revealedAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    emailRevealCount: { type: Number, default: 0 },

    // ── Additional / alternate phone numbers linked to this lead ─────────────
    // additionalNumbers: {
    //   type: [
    //     {
    //       number:  { type: String, required: true, trim: true },
    //       label:   { type: String, default: "" },   // e.g. "WhatsApp", "Office"
    //       addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    //       addedAt: { type: Date, default: Date.now },
    //     },
    //   ],
    //   default: [],
    // },

    // ── No-action alert tracking (prevents duplicate alerts) ─────────────────
    // Stores timestamps of when 1-hr and 2-hr no-action alerts were sent.
    // Once set, the job skips this lead for that threshold permanently.
    noActionAlert1hSentAt: { type: Date, default: null },
    noActionAlert2hSentAt: { type: Date, default: null },

    // ── No-action 3h escalation guard (super_admin dedup) ────────────────────
    // BUG 2 FIX — without this field the 3h escalation guard in leadAlertsJob
    // never sticks: the query finds the same leads every 15-min tick and the
    // super_admin gets spammed once Bug 1 (sendEscalationAlert) is fixed.
    noActionAlertSuperAdminSentAt: { type: Date, default: null },

    // ── Lead merge tracking ───────────────────────────────────────────────────
    // mergedInto: set on the DUPLICATE lead — points to the surviving lead
    mergedInto: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "Lead",
      default: null,
    },
    // mergedFrom: array on the SURVIVING lead — lists all duplicates absorbed
    // mergedFrom: {
    //   type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lead" }],
    //   default: [],
    // },

    // mergedSourceName: stores the name of the lead that was merged into this one.
    // E.g. when "Shashi" merges into "Divzz", Divzz.mergedSourceName = "Shashi".
    // This makes the surviving lead searchable by the absorbed lead's name.
    mergedSourceName: {
      type:    String,
      default: "",
      trim:    true,
    },

    // ── Close Lead (wrong entry) ──────────────────────────────────────────────
    isClosed: {
      type:    Boolean,
      default: false,
    },

    // ── Interested auto-blast guard ───────────────────────────────────────────
    // Set the first time the WhatsApp/Email/SMS blast fires for this lead
    // after it's marked Interested — guarantees the blast goes out only once.
    interestedBlastSentAt: {
      type:    Date,
      default: null,
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

    // ── AI Action Summary (Grok) ──────────────────────────────────────────────
    // On-demand summary built from the lead's remarks (call history + meeting
    // remarks) — plus call transcripts/summaries on Pro/Advance — to suggest the
    // next best action. Cached here and regenerated only when new activity is
    // added (guarded by actionSummarySignature, a hash of the inputs).
    actionSummary: {
      summary:     { type: String, default: "" },
      nextAction:  { type: String, default: "" },
      keyPoints:   { type: [String], default: [] },
      sentiment:   { type: String, default: "" },   // Positive | Neutral | Negative
      suggestedTemp: { type: String, default: null }, // Hot | Warm | Cold | null
      basedOn:     { type: String, default: "" },   // "remarks" | "remarks+calls"
      generatedAt: { type: Date,   default: null },
      model:       { type: String, default: "" },
    },
    // Signature of the inputs (remark + call counts/timestamps) that produced the
    // cached actionSummary. If the current signature differs, the summary is stale
    // and will be regenerated on the next request.
    actionSummarySignature: { type: String, default: "" },
  },
  { timestamps: true }
);

// ── Performance indexes ───────────────────────────────────────────────────────
leadSchema.index({ company: 1 });
leadSchema.index({ company: 1, user: 1, status: 1 });
leadSchema.index({ company: 1, createdAt: -1 });
leadSchema.index({ company: 1, mobile: 1 });

// ── Critical indexes for Dashboard, Daily Report & Report Page ────────────────
// date index: used by every daily report query ($gte/$lte date filtering)
leadSchema.index({ company: 1, date: -1 });
// temperature index: used by dashboard-stats countDocuments (Hot/Warm/Cold)
leadSchema.index({ company: 1, temperature: 1 });
// campaign index: used by report page campaign filtering
leadSchema.index({ company: 1, campaign: 1 });
// status index: used by report page and daily report status filtering
leadSchema.index({ company: 1, status: 1 });
// user+date compound: used by per-employee daily report queries
leadSchema.index({ company: 1, user: 1, date: -1 });
// phoneRevealCount: used by dashboard-stats reveal aggregation
leadSchema.index({ company: 1, phoneRevealCount: 1 });
// isClosed: used by employee report excludeClosed filter
leadSchema.index({ company: 1, isClosed: 1 });

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
// ── PHONE DEDUP: Partial unique index on normalizedSecondaryPhone ─────────────
// Prevents two leads in the same company from owning the same secondary number.
leadSchema.index(
  { company: 1, normalizedSecondaryPhone: 1 },
  {
    unique: true,
    partialFilterExpression: {
      normalizedSecondaryPhone: { $type: 'string', $exists: true },
    },
    name: 'company_normalizedSecondaryPhone_unique',
  }
);
leadSchema.index({ normalizedSecondaryPhone: 1 }, { sparse: true });



// ── Pre-validate hook: compute normalizedPhone automatically ─────────────────
// ── Pre-validate hook: normalize phones + enforce schema-level rules ──────────
leadSchema.pre('validate', async function () {
  // ── Primary phone ──────────────────────────────────────────────────────────
  if (this.mobile) {
    const n = normalizePhone(this.mobile);
    this.normalizedPhone = n || null;
    // Keep primaryPhone in sync with mobile (backward compat)
    if (!this.primaryPhone) this.primaryPhone = this.mobile;
  }
  // If primaryPhone was set directly (without mobile), sync mobile too
  if (this.primaryPhone && !this.mobile) {
    this.mobile = this.primaryPhone;
    this.normalizedPhone = normalizePhone(this.primaryPhone) || null;
  }

  // ── Secondary phone ────────────────────────────────────────────────────────
  if (this.secondaryPhone) {
    const ns = normalizePhone(this.secondaryPhone);
    this.normalizedSecondaryPhone = ns || null;

    // Schema-level guard: secondary cannot equal primary
    if (ns && ns === this.normalizedPhone) {
      throw new Error('Secondary phone cannot be the same as primary phone.');
    }
  } else {
    // Explicitly nullify so the unique partial index ignores empty values
    this.normalizedSecondaryPhone = null;
  }
});

// ── Pre-findOneAndUpdate / updateOne / updateMany hooks ───────────────────────
async function syncNormalizedPhoneOnUpdate() {
  try {
    const update = this.getUpdate();
    if (!update) return;
    if (!update.$set) update.$set = {};

    // ── Primary phone sync ─────────────────────────────────────────────────
    const mobile       = update.$set.mobile       || update.mobile;
    const primaryPhone = update.$set.primaryPhone  || update.primaryPhone;

    if (mobile) {
      update.$set.normalizedPhone  = normalizePhone(mobile) || null;
      // Sync primaryPhone to match mobile for backward compat
      if (!update.$set.primaryPhone) update.$set.primaryPhone = mobile;
    } else if (primaryPhone) {
      // primaryPhone changed directly — sync mobile too
      update.$set.normalizedPhone = normalizePhone(primaryPhone) || null;
      if (!update.$set.mobile) update.$set.mobile = primaryPhone;
    }

    // ── Secondary phone sync ───────────────────────────────────────────────
    const secondary = update.$set.secondaryPhone !== undefined
      ? update.$set.secondaryPhone
      : update.secondaryPhone;

    if (secondary !== undefined) {
      update.$set.normalizedSecondaryPhone = secondary
        ? (normalizePhone(secondary) || null)
        : null;
    }

    // ── If secondaryPhone is being explicitly removed, clear normalized too ─
    if (update.$set.secondaryPhone === null || update.$set.secondaryPhone === '') {
      update.$set.normalizedSecondaryPhone = null;
    }

    this.setUpdate(update);
  } catch (err) {
    console.error("syncNormalizedPhoneOnUpdate error:", err);
  }
}
leadSchema.pre('findOneAndUpdate', syncNormalizedPhoneOnUpdate);
leadSchema.pre('updateOne',        syncNormalizedPhoneOnUpdate);
leadSchema.pre('updateMany',       syncNormalizedPhoneOnUpdate);

const Lead = mongoose.model("Lead", leadSchema);
module.exports = Lead;