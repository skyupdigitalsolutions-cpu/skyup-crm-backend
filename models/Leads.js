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
    // Precise, time-matched reminder (separate from the once-daily 9:30 AM
    // digest in jobs/leadAlertsJob.js runFollowUpAlerts()). Tracks whether a
    // push notification has already fired for THIS specific scheduled call,
    // so the 5-minute scan in runScheduledCallReminders() never re-notifies
    // for the same entry once it's been sent.
    reminderSentAt: { type: Date, default: null },
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
    // Kept for backward compatibility with meetings logged before the
    // `documents` array below existed — old records still read from these.
    documentUrl:  { type: String, default: null },
    documentName: { type: String, default: null },
    recordingUrl: { type: String, default: null },
    recordingName:{ type: String, default: null },
    // ── Proposal tracking ────────────────────────────────────────────────
    proposalSent:   { type: Boolean, default: false },
    proposalSentAt: { type: Date, default: null },
    // ── Free-form "anything else" notes — separate from `remark` (the main
    // meeting summary) so the two don't get conflated in the UI or reports.
    additionalInfo: { type: String, default: '' },
    // ── Multiple documents per meeting (proposal, contract, photos, etc.) —
    // the single documentUrl/documentName above only ever held ONE file.
    documents: {
      type: [
        new mongoose.Schema(
          {
            url:  { type: String, required: true },
            name: { type: String, default: '' },
            // "proposal" | "document" | "other" — lets the UI group/label
            // attachments (e.g. show a distinct "Proposal" chip) without
            // needing a separate array per category.
            type: { type: String, enum: ['proposal', 'document', 'other'], default: 'document' },
            uploadedAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
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
    // leadgenId is scoped to company via a compound partial index below.
    // Do NOT add unique:true here — that would create a global unique index
    // which incorrectly blocks two different companies from having the same
    // Google Ads leadgenId (which is valid and expected in multi-tenant setups).
    leadgenId: { type: String, default: null },
    name:      { type: String, required: true, trim: true },
    mobile:    { type: String, default: "" },
    email:     { type: String, default: "", trim: true },
    // ── WhatsApp template trigger history (shown in the Update Lead popup) ─────
    // Every automated WhatsApp TEMPLATE actually sent to this lead is appended
    // here (crm_call_answered / crm_call_missed / crm_meeting_scheduled /
    // crm_followup_leads / crm_followup_reminder / client_meeting_reminder …),
    // newest entries pushed to the end. Recorded by autoTemplateService.js and
    // the meeting-reminder sender. This is forward-looking — only sends that
    // happen after deploy are captured.
    templateHistory: {
      type: [
        new mongoose.Schema(
          {
            templateName: { type: String, required: true },
            sentAt:       { type: Date,   default: Date.now },
            channel:      { type: String, default: "whatsapp" },
            status:       { type: String, default: "sent" }, // "sent" | "failed"
            // The actual rendered message text that was sent (template body
            // with {{1}}/{{2}}… placeholders filled in with this lead's real
            // values), so "Templates Sent" views can show WHAT was said, not
            // just the template's internal name. Best-effort: populated when
            // the sender can resolve the template's cached body text (see
            // utils/templateContentResolver.js); left blank for older sends
            // recorded before this field existed.
            content:      { type: String, default: "" },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // ── Telegram notification log ─────────────────────────────────────────────
    // Every Telegram notification actually fired for this lead (new-lead alert
    // to admins, or "lead assigned to you" alert to the employee), so the lead's
    // chronological journey can show exactly when — and to whom — a Telegram
    // ping went out, alongside calls and template sends. Recorded by
    // services/telegramService.js. Fire-and-forget: a logging failure here must
    // never block or fail the actual notification send.
    telegramNotifications: {
      type: [
        new mongoose.Schema(
          {
            // "employee_assigned" | "employee_followup" | "campaign_admin" | "campaign_company"
            type:          { type: String, required: true },
            recipientName: { type: String, default: "" },
            recipientRole: { type: String, default: "" }, // "employee" | "admin"
            sentAt:        { type: Date,   default: Date.now },
            status:        { type: String, default: "sent" }, // "sent" | "failed"
            detail:        { type: String, default: "" },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // ── WhatsApp screenshot evidence ──────────────────────────────────────────
    // Manual proof of a WhatsApp conversation with the lead that happened
    // OUTSIDE the CRM's own WhatsApp integration — e.g. an agent chatting
    // with the lead on their personal number. Purely evidentiary; unrelated
    // to WhatsAppMessage/WhatsAppConversation (the official in-app thread).
    whatsappScreenshots: {
      type: [
        new mongoose.Schema(
          {
            url:        { type: String, required: true },
            name:       { type: String, default: "" },
            note:       { type: String, default: "" },
            uploadedAt: { type: Date, default: Date.now },
            userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
            userName:   { type: String, default: "" },
          },
          { _id: true }
        ),
      ],
      default: [],
    },

    source:    { type: String, required: true, trim: true },
    campaign:  { type: String, required: false, default: null },

    // True for leads created through the Import CSV / Excel flow. Used to
    // exclude imported leads from the "Not Answered" outcome automation (they
    // should not receive the crm_call_missed template). Other automations are
    // unaffected.
    importedViaCsv: { type: Boolean, default: false },

    // True for leads created through the "Add Lead" button (manual entry).
    // Also excluded from the "Not Answered" outcome automation — that template
    // fires only for campaign leads (Meta / Website / Google Ads / etc.).
    addedManually:  { type: Boolean, default: false },
    adSetName: { type: String, default: "", trim: true },
    // Reference to the exact MetaConfig (ad set) this lead came from. Lets the
    // Campaigns page count leads per AD SET instead of per campaign name (which
    // collides when several ad sets share a campaign name).
    metaConfigId: { type: mongoose.Schema.Types.ObjectId, ref: "MetaConfig", default: null, index: true },
    linkedinConfigId: { type: mongoose.Schema.Types.ObjectId, ref: "LinkedInConfig", default: null, index: true },
    // The exact Meta lead FORM id this lead was submitted through. In Meta, each
    // lead form belongs to one ad set, so formId is the ground-truth key for
    // attributing a lead to its ad set — independent of the campaign name. Stored
    // so leads can be re-attributed to the correct ad-set config if they were
    // routed to a catch-all config at ingestion time.
    formId: { type: String, default: "", trim: true, index: true },
    // Optional lead language (auto-detected from the ad form when present, or set
    // manually). Empty string = unknown. Used to route/filter leads to employees
    // who can communicate in that language.
    language:  { type: String, default: "", trim: true, index: true },

    // ── Nurture targeting (drives the 1,760-template WhatsApp sequences) ──────
    // The approved MSG91 template name is derived at send time as:
    //   slug(industry)_slug(service)_<stage>_v<n>
    //   e.g. "interior_designers_social_media_marketing_desire_v2"
    // Both must be set for a lead to receive an industry-specific nurture
    // message. If either is empty, jobs/nurtureSequenceJob.js falls back to the
    // rule's manual template list and never guesses — sending a Healthcare
    // template to a Real Estate lead is worse than sending nothing.
    //
    // Values must match utils/templateNameResolver.js INDUSTRIES / SERVICES
    // exactly, because their slug becomes part of the approved template name.
    industry: { type: String, default: "", trim: true, index: true },
    service:  { type: String, default: "", trim: true, index: true },

    // The lead's own business name — used for the {{2}} body variable in every
    // nurture template ("is {{2}} getting enough new patients?"). Distinct from
    // `name` (the contact person) and `company` (the CRM tenant that owns this
    // lead). When empty the sender falls back to a neutral phrase so the send
    // still succeeds — Meta rejects a template send with a missing variable.
    businessName: { type: String, default: "", trim: true },

    status:    { type: String, required: true, trim: true },
    date:      { type: Date, required: true },
    remark:    { type: String, required: true, trim: true },
    // The ORIGINAL remark captured when the lead was first created (campaign /
    // ad-form / manual / import). Unlike `remark` — which is overwritten with the
    // latest call/meeting remark — this is written once at creation and never
    // changed, so the app can always show the lead's initial campaign remark.
    initialRemark: { type: String, default: "" },
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

    // ── Client-side encryption fields ────────────────────────────────────────
    // mobile is encrypted by the FRONTEND before sending (AES-256-GCM with the
    // company key). The backend stores and returns only ciphertext ("enc:...").
    // mobileHash is HMAC-SHA256(plainMobile, companyKey) — computed by the
    // frontend alongside the encrypted value. The backend uses it to look up
    // leads by phone number for incoming WhatsApp messages and call matching,
    // without ever needing to decrypt the mobile field.
    mobileHash: {
      type:    String,
      default: null,
      trim:    true,
      index:   true,   // fast lookup for WhatsApp webhook + call matching
    },
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

    // ── Follow-up reminder tracking (WhatsApp + Email to the LEAD) ────────────
    // followUpReminderJob.js sends a WhatsApp + Email nudge to the lead twice a
    // day (9:30 AM & 8:30 PM IST) whenever this lead has a pending (not done)
    // scheduledCalls entry of type "follow-up" that is due today or overdue.
    // These two fields dedupe sends so the same slot never fires twice in one
    // calendar day (IST) — reset naturally once the day rolls over, since the
    // job compares against "today's" IST date key each run.
    followUpReminderLastSentDate: { type: String, default: null }, // "YYYY-M-D" (IST)
    followUpReminderLastSentSlot: { type: String, default: null }, // "morning" | "evening"

    // Start (IST day key) of the current reminder cycle. The reminder now fires
    // only once every N days (default 3) instead of daily: both the 9:30 AM and
    // 8:30 PM slots fire on the cycle-start day, then the lead is skipped until
    // N days have elapsed. Reset to the new day whenever a fresh cycle begins.
    followUpReminderCycleStart:   { type: String,  default: null }, // "YYYY-M-D" (IST)

    // Set true when a lead taps the "Stop Promotion" button on the
    // crm_followup_reminder WhatsApp template. Opted-out leads are permanently
    // excluded from the follow-up reminder job (other automations still fire).
    followUpReminderOptOut:       { type: Boolean, default: false },

    // ── "No follow-up date set" alert tracking (push notification to EMPLOYEE) ─
    // leadAlertsJob's runNoFollowUpDateCheck() nudges the assigned employee when
    // a lead has gone 24h+ since creation with NO scheduledCalls entry at all
    // (i.e. the employee never picked a follow-up date). Re-fires every 24h
    // until a follow-up is finally scheduled — this field just tracks the last
    // time we pinged them so we don't spam every 15-min tick.
    noFollowUpAlertLastSentAt:    { type: Date, default: null },

    // ── Per-outcome automation dedupe (WhatsApp + Email to the LEAD) ──────────
    // Maps an outcome key (e.g. "answered", "notAnswered", "busy", "switchOff",
    // "callBackLater", "notInterested") → the IST calendar-day key ("YYYY-M-D")
    // on which that outcome's automation last fired for THIS lead. Powers the
    // "at most once per lead, per outcome, per day" guard in
    // services/outcomeAutomationService.js, so an agent picking the same
    // outcome multiple times in one day only triggers one message.
    outcomeAutomationSent: { type: Map, of: String, default: () => ({}) },

    // ── Nurture sequence dedupe (jobs/nurtureSequenceJob.js) ──────────────────
    // Maps a NurtureRule _id (string) → the IST calendar-day key on which that
    // rule last fired for THIS lead. Company-scoped feature (see
    // Company.devOverrides.featureToggles.leadNurtureSequence) — only ever
    // populated for the one company that has it enabled. A rule with
    // repeatEveryDays set can fire again once that many days have elapsed
    // since the stored date; a rule with repeatEveryDays = null fires once
    // and is then permanently skipped for this lead.
    // nurtureSent: Map<ruleId, { lastFiredDate: string (IST day key), lastVariationIndex: number, stage: string }>
    // lastVariationIndex tracks sequential V1→V5 rotation per lead per stage.
    // stage tracks which CRM status stage was active when the rule last fired —
    // when the lead moves to a new status, index resets to -1 so V1 fires first.
    // Backward-compatible: old string values (plain date) are handled in nurtureSequenceJob.
    nurtureSent: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => ({}) },

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
// no-follow-up-date alert: leadAlertsJob's runNoFollowUpDateCheck() scans
// { company, isClosed:{$ne:true}, status:{$nin}, date:{$lte}, ... } every
// 15 minutes — this covers the company+date prefix used by that scan.
leadSchema.index({ company: 1, date: 1, noFollowUpAlertLastSentAt: 1 });

// PERF FIX: covers GET /lead/my-leads — the single most-hit mobile endpoint
// (every screen open, pull-to-refresh, and background poll). Its query is
// { company, user, mergedInto: null, isClosed: { $ne: true } } sorted by
// createdAt: -1. None of the indexes above cover that combination — Mongo
// was falling back to the {company,user,status} or {company,user,date}
// prefix, then sorting every matching lead IN MEMORY on every request
// (mergedInto/createdAt weren't indexed together at all). That in-memory
// sort grows linearly with each employee's total historical lead count, so
// the endpoint gets measurably slower over weeks of continued use even
// though nothing in the request itself changed. This index lets Mongo
// satisfy the company+user+mergedInto equality AND the createdAt sort
// directly from the index (ESR: Equality, Sort, Range) — isClosed's $ne
// gets filtered inline during that same index scan instead of triggering a
// separate unindexed pass.
leadSchema.index({ company: 1, user: 1, mergedInto: 1, createdAt: -1 });

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

// ── LEADGEN DEDUP: Company-scoped partial index on leadgenId ──────────────────
// Replaces the old global unique:true sparse index on the field itself.
// This correctly scopes dedup to within a single company (multi-tenant safe).
// partialFilterExpression ensures null/missing leadgenId values are excluded.
leadSchema.index(
  { company: 1, leadgenId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      leadgenId: { $type: 'string', $exists: true },
    },
    name: 'company_leadgenId_unique',
  }
);



// ── Pre-validate hook: compute normalizedPhone automatically ─────────────────
// ── Pre-validate hook: normalize phones + enforce schema-level rules ──────────
leadSchema.pre('validate', async function () {
  // ── Capture the initial (campaign / source) remark ONCE, at creation ────────
  // `remark` is later overwritten with the latest call/meeting remark, so we
  // snapshot the original here the first time the document is saved. Never
  // touched again afterwards.
  if (this.isNew && (!this.initialRemark || !this.initialRemark.trim())) {
    this.initialRemark = (this.remark || '').trim();
  }

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

// ── Pre-insertMany hook: capture initialRemark for bulk (Excel) imports ───────
// insertMany does NOT trigger per-document pre('save')/pre('validate') hooks,
// so we snapshot the initial remark here for every inserted row.
leadSchema.pre('insertMany', function (next, docs) {
  try {
    if (Array.isArray(docs)) {
      for (const d of docs) {
        if (d && (!d.initialRemark || !String(d.initialRemark).trim())) {
          d.initialRemark = (d.remark || '').toString().trim();
        }
      }
    }
  } catch (err) {
    console.error('leadSchema pre-insertMany initialRemark error:', err);
  }
  next();
});

const Lead = mongoose.model("Lead", leadSchema);
module.exports = Lead;
