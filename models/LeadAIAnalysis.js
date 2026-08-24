// models/LeadAIAnalysis.js
// ─────────────────────────────────────────────────────────────────────────────
// Stores the result of every AI lead outcome analysis.
// One document per lead — upserted each time analysis runs.
// Company isolation enforced identically to all other SkyUp CRM models.
// ─────────────────────────────────────────────────────────────────────────────
const mongoose = require("mongoose");

const evidenceSchema = new mongoose.Schema(
  {
    type:        { type: String }, // CALL | WHATSAPP | FOLLOW_UP | MEETING | REMARK | STAGE_CHANGE
    referenceId: { type: String, default: null },
    finding:     { type: String },
    impact:      { type: String, enum: ["HIGH", "MEDIUM", "LOW"], default: "MEDIUM" },
    date:        { type: Date, default: null },
  },
  { _id: false }
);

const reasonSchema = new mongoose.Schema(
  {
    code:                   { type: String }, // e.g. POOR_FOLLOW_UP
    label:                  { type: String },
    responsibleType:        { type: String, enum: ["SALESPERSON", "CUSTOMER", "COMPANY_PRODUCT", "SHARED", "UNKNOWN"] },
    responsibleUserId:      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    responsibleName:        { type: String, default: null },
    responsibilityPercentage: { type: Number, default: 0 },
    confidence:             { type: Number, default: 0 },
    impact:                 { type: String, enum: ["HIGH", "MEDIUM", "LOW"], default: "MEDIUM" },
  },
  { _id: false }
);

const leadAIAnalysisSchema = new mongoose.Schema(
  {
    leadId:    { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true, index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },

    // ── Core outcome ──────────────────────────────────────────────────────────
    outcome:     { type: String, enum: ["ACTIVE", "CONVERTED", "NOT_CONVERTED"], default: "ACTIVE" },
    currentStage: { type: String, default: "" },
    leadHealth:   { type: String, enum: ["HEALTHY", "AT_RISK", "CRITICAL", "LOST"], default: "HEALTHY" },
    conversionProbability: { type: Number, default: 0, min: 0, max: 100 },

    // ── Responsibility ────────────────────────────────────────────────────────
    primaryReason:    { type: reasonSchema, default: null },
    secondaryReasons: { type: [reasonSchema], default: [] },

    // ── Narrative ─────────────────────────────────────────────────────────────
    explanation: { type: String, default: "" },
    evidence:    { type: [evidenceSchema], default: [] },

    // ── Communication analysis ────────────────────────────────────────────────
    communicationAnalysis: {
      customerSentiment: { type: String, default: null },
      purchaseIntent:    { type: Number, default: null },
      mainObjection:     { type: String, default: null },
    },

    // ── Objective metrics (calculated by backend — not AI) ────────────────────
    metrics: {
      totalCalls:                { type: Number, default: 0 },
      answeredCalls:             { type: Number, default: 0 },
      missedCalls:               { type: Number, default: 0 },
      totalFollowUps:            { type: Number, default: 0 },
      completedFollowUps:        { type: Number, default: 0 },
      missedFollowUps:           { type: Number, default: 0 },
      averageFollowUpDelayDays:  { type: Number, default: null },
      whatsappSent:              { type: Number, default: 0 },
      whatsappReceived:          { type: Number, default: 0 },
      whatsappResponseRate:      { type: Number, default: null }, // 0-100
      meetingsScheduled:         { type: Number, default: 0 },
      meetingsCompleted:         { type: Number, default: 0 },
      meetingsCancelled:         { type: Number, default: 0 },
      daysSinceLastCustomerResponse: { type: Number, default: null },
      daysSinceLastEmployeeAction:   { type: Number, default: null },
      stageDurationDays:         { type: Number, default: 0 },
      numberOfStageChanges:      { type: Number, default: 0 },
    },

    // ── Recommended next steps ────────────────────────────────────────────────
    recommendedActions: { type: [String], default: [] },

    // ── Meta ─────────────────────────────────────────────────────────────────
    generatedAt:     { type: Date, default: Date.now },
    model:           { type: String, default: "gpt-4o-mini" },
    analysisVersion: { type: String, default: "1.0" },
    status:          { type: String, enum: ["pending", "processing", "done", "failed"], default: "pending" },
    errorMessage:    { type: String, default: null },

    // Track what triggered this analysis
    triggeredBy: { type: String, default: "manual" }, // manual | call | whatsapp | followup | meeting | stage_change
  },
  { timestamps: true }
);

// One analysis doc per lead (upsert pattern)
leadAIAnalysisSchema.index({ leadId: 1 }, { unique: true });
leadAIAnalysisSchema.index({ companyId: 1, leadHealth: 1 });
leadAIAnalysisSchema.index({ companyId: 1, outcome: 1 });
leadAIAnalysisSchema.index({ companyId: 1, "primaryReason.responsibleUserId": 1 });

module.exports = mongoose.model("LeadAIAnalysis", leadAIAnalysisSchema);
