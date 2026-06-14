// models/MetaQualification.js
// Stores lead-qualification scoring rules for one Meta Ad Set config.
//
// Scoring model (new):
//   • Every question's answer options must sum to EXACTLY 100 points.
//   • A lead earns the points of the single selected answer per question.
//   • Maximum possible score = (number of questions) × 100.
//   • Percentage = (leadScore / maxScore) × 100.
//   • Category is decided by percentage thresholds (hot / warm).
const mongoose = require("mongoose");

// Each question's options must total exactly this many points.
const POINTS_PER_QUESTION = 100;

const answerScoreSchema = new mongoose.Schema(
  {
    value: { type: String, default: "" },  // answer text from the Meta form
    score: { type: Number, default: 0 },   // points awarded when this answer is chosen
  },
  { _id: false }
);

const questionRuleSchema = new mongoose.Schema(
  {
    questionKey:   { type: String, required: true }, // field_key from Meta lead-form
    questionLabel: { type: String, default: "" },    // human-readable label shown in UI
    answers:       [answerScoreSchema],
  },
  { _id: false }
);

const metaQualificationSchema = new mongoose.Schema(
  {
    adSetId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "MetaConfig",
      required: true,
      unique:   true,   // one rule-set per ad set
    },
    adSetName: { type: String, default: "" },
    formId:    { type: String, default: "" },
    company: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "Company",
      required: true,
    },
    // Per-question scoring rules
    rules: [questionRuleSchema],
    // Percentage thresholds: score% >= hot → Hot, >= warm → Warm, else → Cold
    thresholds: {
      hot:  { type: Number, default: 80 },
      warm: { type: Number, default: 50 },
    },
    // Maximum possible score = number of questions × POINTS_PER_QUESTION (100).
    // Stored so consumers (lists, reports, exports) don't have to recompute.
    maxScore: { type: Number, default: 0 },
    // Whether every question's options sum to exactly 100. When false the
    // rule-set is considered invalid and must be corrected before activation.
    optionsValid: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/**
 * Validate that every question's answer options sum to EXACTLY 100 points.
 * Returns { valid, maxScore, errors:[{index, questionLabel, total}] }.
 */
metaQualificationSchema.statics.validateRules = function (rules = []) {
  const errors = [];
  (rules || []).forEach((rule, index) => {
    const total = (rule.answers || []).reduce(
      (sum, a) => sum + (Number(a.score) || 0),
      0
    );
    if (total !== POINTS_PER_QUESTION) {
      errors.push({
        index,
        questionKey:   rule.questionKey || "",
        questionLabel: rule.questionLabel || rule.questionKey || `Question ${index + 1}`,
        total,
      });
    }
  });
  return {
    valid:    errors.length === 0,
    maxScore: (rules || []).length * POINTS_PER_QUESTION,
    errors,
  };
};

// Keep maxScore / optionsValid in sync automatically on every save.
// Note: declared WITHOUT a `next` callback so Mongoose treats it as a
// synchronous hook and proceeds on return. (In Mongoose 7+, `next` is not
// passed to sync-style hooks, so calling it would throw "next is not a function".)
metaQualificationSchema.pre("validate", function () {
  const { valid, maxScore } =
    this.constructor.validateRules(this.rules || []);
  this.maxScore     = maxScore;
  this.optionsValid = valid;
});

metaQualificationSchema.statics.POINTS_PER_QUESTION = POINTS_PER_QUESTION;

module.exports = mongoose.model("MetaQualification", metaQualificationSchema);